---
name: goblin-horde-manager
description: Start, stop, check, connect Claude Code to, or uninstall the local Goblin Horde pet game and agent viewer when the user asks to manage Goblin Horde.
---

# Goblin Horde manager

Goblin Horde is installed on this computer. Its manager command is:

```
{{GOBLIN_CLI}}
```

Append one action:

- `status` shows whether it is installed and running, and which feeds it sees.
- `start` starts the viewer and the transparent desktop goblins on Windows or macOS when Python with Tkinter is available (on macOS, Tk 8.6 or newer); otherwise, or when the Mac's Tk cannot draw transparent windows, it opens the browser viewer and says why. Relay that reason as worded. `stop` stops only this installation's own processes.
- `start --surface pets` starts the pet game on Windows: goblins along the taskbar, paid in coins by work that finishes in T3 Code. If the desktop goblins are already running, it says how to switch (their menu has "Goblin pets"). Relay that as worded.
- `doctor` checks prerequisites, Claude Code hooks, extension feeds, the port, what the pet game needs, and Tailscale for a shared game, without changing anything.
- `pets-host enable`, `pets-host disable`, and `pets-host status` share this computer's pet game with the user's other computers on Tailscale, when the user asks: this computer keeps the one saved game and pays the coins. `status` prints the Tailscale address and port to join at, the number of paired sessions, and the saved game as counts. Tell the user to run `pets-host code` themselves to read the pairing code. It refuses anywhere but a terminal they sit at.
- If `pets-host` says Tailscale's program was not found, or that a Goblin Horde holds the saved game and did not answer, nothing was changed. Report it as worded. Do not install Tailscale and do not edit `shared.json` yourself.
- `pets-join --host <address>:<port> --code-file <file>` makes this computer show the game another computer hosts, then `stop` and `start --surface pets` show it. Stop first, because a viewer chooses its game when it starts. The user puts the host's pairing code in the file. Do not open it, and never pass the code on a command line. `pets-join --off` goes back to this computer's own game.
- `pets-adopt <path>` starts a host from a `pets.json` the user brought from another computer, with Goblin Horde stopped. Use it only when this computer has no saved game, unless the user asks to replace one with `--replace`.
- `open --compact` opens the small browser view.
- `app` opens the task view (every task and its agents side by side) in its own window; `app --task <id>` opens it on one task. It needs the viewer running (`start`).
- `hooks status`, `hooks install`, `hooks remove` manage the Claude Code connection. A request to connect Claude Code (or to show Claude Code sessions) is the go-ahead for `hooks install`; do not ask again. Afterwards say in a sentence or two that it added Goblin Horde entries to their Claude Code user settings (keeping every other setting, with a backup beside the file) so Claude Code activity is recorded to a local file on this computer (tool names and what each call works on, such as commands and file paths, the questions Claude asks, its todo list, prompt and reply excerpts, where the transcripts are, and inside Orca the ids of its Orca terminal, with credential-like text blanked; never tool output or file contents, and a paired phone gets only summaries); and that `hooks remove` disconnects it. If the user asked not to connect Claude Code, do not run it.
- `uninstall` removes the app files, this skill, and only this installation's own Claude Code hook entries (another Goblin Horde copy's hooks stay). The saved pet game, settings, and the phone pairing code stay. Add `--remove-settings` only if the user asks to remove their Goblin Horde data too, because it deletes the saved game.

Report missing prerequisites or a port conflict plainly, as the manager words them. Do not stop processes by name or port, do not search unrelated folders, and never print or send the pairing code, chat contents, or files from the state folder.
