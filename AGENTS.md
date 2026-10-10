# Goblin Horde package

This folder is the portable Goblin Horde package for Windows, macOS, and Linux. Its manager is `goblin.mjs` and needs only Node.js 20 or newer. Read `README.md` before acting.

**Set up.** When the user asks to install or set it up, run `node goblin.mjs doctor` from this folder and report anything missing in plain words. Do not install Node, Python, Codex, Claude Code, or Orca unless the user separately asks. Then install, without stopping to ask about Claude Code:

- Claude Code is on this computer (doctor's `claude` check is ✓) and the user did not say to leave it out: run `node goblin.mjs install --claude-hooks`. Asking to install Goblin Horde is the go-ahead for this; it is how Claude Code sessions appear.
- The user said not to connect Claude Code: run `node goblin.mjs install --no-claude-hooks`.
- Claude Code is not on this computer: run `node goblin.mjs install`.

When Claude Code was connected, say so in the report in a sentence or two: it added Goblin Horde hook entries to their Claude Code user settings (`~/.claude/settings.json` or `CLAUDE_CONFIG_DIR`), kept every other setting, saved a backup beside the file, and records only tool names, file base names, statuses, and short reply excerpts to a local file; never prompts, tool input or output, commands, or transcripts. Give the opt-out: `hooks remove` with the installed manager (the install output prints the exact command). If install refused to edit the settings file, report why and that nothing was changed. Install copies only the files in `package-files.json` into the user's own app folder, installs a manager skill for Codex and Claude Code, and starts Goblin Horde: the transparent desktop goblins on Windows or macOS with Python/Tkinter, otherwise the browser viewer. It never starts at login.

**Later.** Use the installed copy's manager (the installed skill gives its path): `start`, `stop`, `status`, `doctor`, `open --compact`, `hooks install|remove|status`. `stop` and `uninstall` end only processes running this installation's own files. `uninstall` removes the app files, its skills, and only this installation's own Claude Code hook entries (another Goblin Horde copy's hooks stay); settings and the phone pairing code stay. Use `--remove-settings` only when the user asks to remove their Goblin Horde data too. On Windows, `manage.ps1 -Action Install|Start|Stop|Status|Uninstall` runs the same manager. Do not remove this source folder unless the user asks.

**Report plainly** missing prerequisites, a port conflict (the manager says whether another program or another Goblin Horde copy holds the port; suggest `--port`), or a Claude Code settings file it refused to edit and why. On macOS, if the manager opened the browser viewer instead of the desktop goblins, give its reason (no Python 3 with Tk 8.6+, or a Tk that cannot draw transparent windows) and say python.org Python or Homebrew `python-tk` provides it; do not install it unless asked. On Linux, say the browser viewer is used because the transparent desktop widget runs on Windows and macOS.

**Privacy.** Never print or transmit the pairing code, chat contents, Claude Code settings contents, or files from the Goblin Horde state folder during setup or removal. Other orchestrators connect through the NDJSON format in `EXTENSIONS.md`; never forward raw commands or tool output into a feed.

**Tests and packaging** (source checkout only): `npm test` uses temporary folders and never touches real settings or starts the viewer. `node scripts/package.mjs` builds `dist/GoblinHorde-Team.zip` from `package-files.json`; add any new runtime file there.
