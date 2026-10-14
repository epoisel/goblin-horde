---
name: goblin-horde-manager
description: Start, stop, check, connect Claude Code to, or uninstall the local Goblin Horde agent viewer when the user asks to manage Goblin Horde.
---

# Goblin Horde manager

Goblin Horde is installed on this computer. Its manager command is:

```
{{GOBLIN_CLI}}
```

Append one action:

- `status` shows whether it is installed and running, and which feeds it sees.
- `start` starts the viewer and the transparent desktop goblins on Windows or macOS when Python with Tkinter is available (on macOS, Tk 8.6 or newer); otherwise, or when the Mac's Tk cannot draw transparent windows, it opens the browser viewer and says why. Relay that reason as worded. `stop` stops only this installation's own processes.
- `doctor` checks prerequisites, Claude Code hooks, extension feeds, and the port without changing anything.
- `open --compact` opens the small browser view.
- `hooks status`, `hooks install`, `hooks remove` manage the Claude Code connection. A request to connect Claude Code (or to show Claude Code sessions) is the go-ahead for `hooks install`; do not ask again. Afterwards say in a sentence or two that it added Goblin Horde entries to their Claude Code user settings (keeping every other setting, with a backup beside the file) so Claude Code activity is recorded to a local file on this computer (tool names and what each call works on, such as commands and file paths, the questions Claude asks, its todo list, prompt and reply excerpts, and where the transcripts are, with credential-like text blanked; never tool output or file contents, and a paired phone gets only summaries); and that `hooks remove` disconnects it. If the user asked not to connect Claude Code, do not run it.
- `uninstall` removes the app files, this skill, and only this installation's own Claude Code hook entries (another Goblin Horde copy's hooks stay). Settings and the phone pairing code stay. Add `--remove-settings` only if the user asks to remove their Goblin Horde data too.

Report missing prerequisites or a port conflict plainly, as the manager words them. Do not stop processes by name or port, do not search unrelated folders, and never print or send the pairing code, chat contents, or files from the state folder.
