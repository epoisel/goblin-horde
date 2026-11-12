# Dev tools for the pet game

Source checkout only. None of these tools is in `package-files.json`, so none ships.

## `clean-install.mjs`: the team ZIP installed from a clean folder

```
node scripts/package.mjs
node scripts/dev/clean-install.mjs [--zip path/to/GoblinHorde-Team.zip] [--keep]
```

Unzips `dist/GoblinHorde-Team.zip` into a new temp folder and runs what an agent on another computer runs: the package's own `doctor` and `install`. Then, from the installed copy, it imports every pet game Python module and builds a world, a goblin image, and a boss image on a hidden Tk root. It starts the installed local server without the game's window and checks that a turn finished in a fixture T3 database pays coins. It then shares that game: `pets-host enable` on the running copy, a second installed copy that runs `pets-join` and shows the first copy's coins, and `pets-host disable`. `GOBLIN_SHARED_LOOPBACK` keeps the shared listener on 127.0.0.1, so Tailscale is never asked. Each installed copy runs `update --off` before it starts, so no server in the sandbox looks on github.com for an update. Last, it runs `stop`, `uninstall`, and a full reset.

The app folder, state folder, home, app-data, Claude, and Codex folders are all inside the temp folder, so nothing real is read or written, and no goblins appear on screen. It prints each command with its output and exits 1 when a check fails. `--keep` leaves the temp folder in place. Needs Node.js 22.13 or newer and a Python with Tkinter.

## `pets-rig.mjs`: the whole game in a sandbox

```
node scripts/dev/pets-rig.mjs --horde 200 --bosses 5 --coins 3000
```

Starts the real `server.mjs` on a free port over a temp folder that holds its state folder and a fixture T3 database. The server's home, app-data, Claude and Codex folders all point into that folder, so the real `~/.t3` and the real Goblin Horde state are never read or written. Needs Node.js 22.13 or newer.

It prints the port, the state folder, and the line that starts a Python widget on it (`GOBLIN_HORDE_STATE_DIR` plus `--port`). Then it reads commands from stdin: `turn [tokens]`, `turns N [gapMs]`, `give coins N`, `horde N [bosses]`, `status`, `wait [ms]`, `help`, `quit`. `give` and `horde` restart the server on the same port, because the saved game is only written while no server runs. `quit`, the end of stdin, or Ctrl+C stops the server and deletes the temp folder. A rig that is killed outright leaves both behind: end the stray `node server.mjs` and delete `goblin-pets-rig-*` from the temp folder.

A script can pipe commands in, or import `startRig({ horde, bosses, coins })`, which returns `{ dir, port, stateDir, env, turn(), seed(), give(), pets(), stop() }`. `test/pets-rig.test.mjs` shows both.

## `screenshot.py`: what the screen shows

```
python scripts/dev/screenshot.py out.png [--region x,y,w,h] [--monitor primary|all]
python scripts/dev/screenshot.py out.png --burst 10 --interval 0.2
```

Saves a PNG of the primary monitor, or of one region in screen pixels (the coordinates a DPI-aware Tk window reports). `--burst` writes `out-0.png`, `out-1.png`, and so on, for motion. Needs Pillow.
