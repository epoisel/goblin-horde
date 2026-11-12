# Goblin Horde

Goblin Horde is a desktop pet game for Windows. Tiny goblins roam along your taskbar, and you can pick them up and drop them onto your open windows. Work that AI agents finish in T3 Code pays coins. Coins recruit more goblins, level the horde up, and send it against bosses.

The earlier Goblin Horde agent monitor is a separate app on the `main` branch of this repository.

> **Status: early (0.6).** It runs day to day on the maintainer's Windows computer. Expect rough edges.

## What you need

- Windows.
- [Node.js](https://nodejs.org) 22.13 or newer.
- [Python 3](https://www.python.org/downloads/) with its default options, which include Tkinter. "Add python.exe to PATH" is not needed.
- T3 Code, opened at least once on this computer.

`node goblin.mjs doctor` checks all of these and changes nothing.

## Install and start

Clone this repository on the `goblin-pets` branch, or unzip `GoblinHorde-Team.zip`. Open a terminal in that folder and run:

```
node goblin.mjs doctor
node goblin.mjs install
```

Install copies the app into `%LOCALAPPDATA%\Programs\GoblinHorde`, installs a small manager skill for Codex and Claude Code, adds a **Goblin Horde** Start menu entry, and starts the game. It needs no administrator rights and never starts at sign-in. To have a coding agent do all of this, give it the prompt in [docs/SETUP-PROMPT.md](docs/SETUP-PROMPT.md).

To start the game again later, choose **Goblin Horde** in the Start menu, or run `node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs" start` (in PowerShell, write `$env:LOCALAPPDATA`). The same manager also takes `stop`, `status`, `doctor`, and `uninstall`.

If port 43917 is busy, the manager says whether another program or another Goblin Horde copy holds it. Close that copy, or add `--port 43918` to the install command.

## Updates

An installed copy keeps itself up to date from this repository's GitHub releases. While the game runs, it looks for a newer release two minutes after it starts and about once a day after that. A release it finds is downloaded into the `updates` folder of `%LOCALAPPDATA%\GoblinHorde`, and it goes in the next time Goblin Horde starts. The game's menu also offers **Update to 0.6.1 and restart** (with the new version's number) to put it in place now. To look and update at once, run the installed manager's `update`.

Every release is signed. A copy uses a release only once the signature in its `update.json` checks out against the key built into the copy, and the package has exactly the signed size, SHA-256, version, and list of files. A release that fails any check is not written anywhere. An update never reads or changes your saved game or your settings. If a new version does not install or does not start, the version before it is put back and started, and the new one is not tried again by itself.

- `update --check` says whether a newer release is there, and changes nothing.
- `update --off` stops the daily look, and `update --on` turns it back on.
- `update --rollback` goes back to the version installed before the last update. That version is then skipped, and the next newer release goes in as usual.

The look asks github.com, and GitHub hands the files out from githubusercontent.com. It sends nothing but an ordinary HTTPS request with the header `User-Agent: GoblinHorde/<version>`.

A copy installed before the updater existed has no updater. Install a build with the updater by hand once on each computer. From then on, releases reach it by themselves.

## How to play

- Hover a goblin to see its name.
- Drag a goblin and drop it onto a window. It stands on the window's top edge.
- Click a small button beside the pill to buy with one click: a goblin, a level, gear, Hoard, Training, or Grip. A bright button is one you can pay for. Hover a button to see what it buys and what it costs.
- Click the pill that shows your coins, or right-click a goblin, to open the menu. The menu has the same purchases, hides the goblins, and quits.
- In the menu, the row that starts with **Send the horde** fights the next boss. **Rerun a boss** fights one you have beaten before.
- During a fight, drop goblins on the boss. Each one that lands takes hold of it and ends the fight a little sooner.

## How coins work

Each AI turn that completes in T3 Code pays coins about a second after it finishes. A failed, cancelled, or interrupted turn pays nothing.

- A turn pays by the square root of its work, so 100 times the tokens pays about 10 times the coins. The work is the fresh input tokens plus five times the output tokens. Cache reads do not count.
- Every completed turn pays at least 2 coins. A turn whose token counts T3 Code did not record pays 2.
- A subagent that finishes pays 4 coins.
- There is no daily limit. Several agents at once each pay in full.
- On the first start, nothing that finished earlier pays. After that, work that finished while the game was closed pays on the next start, up to 7 days back.
- While the game was closed, the horde also earns a small sum for its time away: 0.1 coin a minute for each 100 goblins, for at most 4 hours.

A new game starts with 25 coins and 3 goblins. Recruiting costs 40 coins at first and slightly more for each goblin after that. The **Hoard** upgrade raises the coins each turn pays, and **Training** raises the XP. Levels cost coins and XP. Gear costs scrap. **Grip** lets the pointer pick up one more goblin at once for each level, up to 8 goblins. It costs 50 coins at first and 1.6 times as much for each level after that.

There are 36 bosses, each stronger than the last. A fight is never blocked, and a lost fight costs nothing. The first win against a boss pays the most coins, scrap, and XP. Each rerun of that boss on the same day pays less: 25%, then 10%, then 3% of the first win, and the count starts again the next day. A won fight always pays at least 1 coin, 1 scrap, and 1 XP. Dropping goblins on a boss can cut up to half of the fight's length. It does not change who wins or what the fight pays. Every number is in `game_config.json`. In a source checkout, `docs/game-design.md` explains the reasons for them.

## Move the goblins to another screen

With more than one display, right-click a goblin or click the pill, then choose **Move to screen** and pick a display. Use it to put the goblins on the display you glance at, and keep them off the one you work on. The game remembers the choice. If that display is unplugged, the goblins go to the main display.

## Play one game on several computers

The game pays only for T3 Code work on the computer it runs on. If T3 Code runs its turns on another of your computers, make that computer the host with `pets-host enable`, and join it from this one with `pets-join`. The host keeps the only saved game and pays the coins, and this computer shows its horde over Tailscale.

Sharing is off until you turn it on. The host listens only on its Tailscale address. A computer must be signed in to your Tailscale account and hold the pairing code to join. Only `pets-host code`, in a terminal on the host, shows the code. What crosses between the two computers is the pairing code when this one joins, the purchases and fights it asks for, and the game's numbers and short codes back. No sentence, chat, or T3 Code data crosses.

[docs/SHARED-PETS.md](docs/SHARED-PETS.md) has the steps, what the host checks, what a failed join leaves behind, the limits of the saved game's lock, and how to undo it.

## Your saved game and privacy

The game reads T3 Code's local database read-only, and takes only token counts, statuses, and timestamps from it. It learns where your windows are only as rectangles, with no window titles and no program names. The local server listens on 127.0.0.1 only. Apart from the daily look for an update on github.com, which `update --off` turns off, nothing leaves your computer unless you set up a shared game. [SECURITY.md](SECURITY.md) has the details.

Your saved game is `pets.json` in `%LOCALAPPDATA%\GoblinHorde`, with a backup beside it in `pets.json.bak`. A saved game is never replaced by a new one. If neither file can be read, the game keeps a copy of the file it could not read, starts no new game, and says so.

## Quit and uninstall

**Quit Goblin Horde** in the menu closes the game and stops the local server.

To remove Goblin Horde, run the installed manager's `uninstall`:

```
node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs" uninstall
```

It stops Goblin Horde and removes the app files, the manager skills, and the Start menu entry. Your saved game and settings stay for a later install. Add `--remove-settings` to delete them too, the saved game included. If you installed with `--install-dir`, add the same `--install-dir` to these commands. `--state-dir` and `GOBLIN_HORDE_STATE_DIR` choose another state folder, and `GOBLIN_HORDE_INSTALL_DIR` another app folder.

An earlier build of Goblin Horde could add its own entries to your Claude Code settings file. Install, start, and uninstall take out this installation's own entries and keep every other setting.

## Develop

In a source checkout:

```
npm test
python -m unittest discover -s test -p "test_*.py"
```

The tests use temporary folders, so they never read or change your real settings or start the game. `node scripts/package.mjs` builds `dist/GoblinHorde-Team.zip` from the list in `package-files.json`. It stops if a listed file is missing, looks like local state, or holds a personal folder path, an e-mail address, or credential-like text. `scripts/dev/README.md` describes the tools for trying the game in a sandbox.

### Make a release

Releases are made on the one computer that holds the signing key. Make the key pair once:

```
node scripts/release.mjs keygen
```

It writes the private key to `%USERPROFILE%\.goblin-horde-release\update-key.pem`, readable by your account only, and never prints it. `--private-out` chooses another place. Keep that file safe and back it up offline: whoever holds it can sign code that every installed copy runs. The public key goes into `lib/update-key.mjs`. Commit it, and install that build by hand once on each computer. Keygen refuses to replace a key that is already there, because installed copies trust only the key they were built with.

For each release, raise the version in `package.json`, commit and push, and run:

```
node scripts/release.mjs build
node scripts/release.mjs publish
```

`build` packs and signs `dist/release/GoblinHorde-Team.zip` and `dist/release/update.json`, then checks both with the same verification every installed copy runs, and removes them if they fail. It refuses a version that is not newer than the newest `v*` tag, unless you add `--force-version`. `--key` names another private key file. `publish` prints the `gh` commands that put both files on a `v<version>` pre-release of the current commit, which keeps each build, and on the rolling `pets-latest` pre-release, which is the one installed copies read. Both are pre-releases, so the repository's "Latest" release stays the earlier monitor app's. Run the commands yourself, or run `publish --run`, which first checks `gh auth status`.

## Contributing, security, license

See [CONTRIBUTING.md](https://github.com/epoisel/goblin-horde/blob/goblin-pets/CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Report security problems privately as SECURITY.md describes. Goblin Horde is released under the [MIT license](LICENSE).
