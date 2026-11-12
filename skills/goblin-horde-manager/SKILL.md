---
name: goblin-horde-manager
description: Start, stop, check, share, update, or uninstall the local Goblin Horde pet game when the user asks to manage Goblin Horde.
---

# Goblin Horde manager

The Goblin Horde pet game is installed on this Windows computer. Goblins live along the taskbar, and work that finishes in T3 Code pays them coins. Its manager command is:

```
{{GOBLIN_CLI}}
```

Append one action:

- `status` shows whether it is installed and running.
- `start` starts the local server and the pet game. If the game cannot show, it says why. Relay that reason as worded. `stop` stops only this installation's own processes.
- `doctor` checks what the pet game needs, the port, and Tailscale for a shared game, without changing anything.
- `pets-host enable`, `pets-host disable`, and `pets-host status` share this computer's pet game with the user's other computers on Tailscale, when the user asks. This computer keeps the one saved game and pays the coins. `status` prints the Tailscale address and port to join at, the number of paired sessions, and the saved game as counts. Tell the user to run `pets-host code` themselves to read the pairing code. It refuses anywhere but a terminal they sit at.
- If `pets-host` says Tailscale's program was not found, or that a Goblin Horde holds the saved game and did not answer, nothing was changed. Report it as worded. Do not install Tailscale and do not edit `shared.json` yourself.
- `pets-join --host <address>:<port> --code-file <file>` makes this computer show the game another computer hosts, then `stop` and `start` show it. Stop first, because Goblin Horde chooses its game when it starts. The user puts the host's pairing code in the file. Do not open it, and never pass the code on a command line. `pets-join --off` goes back to this computer's own game.
- `pets-adopt <path>` starts a host from a `pets.json` the user brought from another computer, with Goblin Horde stopped. Use it only when this computer has no saved game, unless the user asks to replace one with `--replace`.
- `update` looks on github.com for a newer signed release and puts it in place now: it stops the game, installs the release with the release's own manager, and starts it. A release is used only once its signature, size, SHA-256, and files check out. If the new version does not install or start, the earlier one is put back and started. `update --check` only says what is there. `update --rollback` goes back to the version installed before the last update. Relay what `update` says as worded, a refusal included, and do not work around one.
- While the game runs it also looks for a release about once a day, and a release it finds goes in at the next start. `update --off` stops that and `update --on` resumes it. Change it only when the user asks. `doctor` and `status` show the last check and any release waiting.
- `uninstall` removes the app files, this skill, the Start menu entry, and only this installation's own Claude Code settings entries. The saved pet game and settings stay. Add `--remove-settings` only if the user asks to remove their Goblin Horde data too, because it deletes the saved game.

Report missing prerequisites or a port conflict plainly, as the manager words them. Do not stop processes by name or port, do not search unrelated folders, and never print or send the pairing code, chat contents, or files from the state folder. The update check sends github.com nothing but an ordinary HTTPS request with `User-Agent: GoblinHorde/<version>`. Never fetch or install a Goblin Horde release any other way, and never change the installed `lib/update-key.mjs` or anything in the state folder's `updates` folder.
