# Join prompt for a shared pet game

Copy the block below and give it to a coding agent (Codex or Claude Code) on the Windows computer that should show the host's game. Start the agent in the folder that holds the unzipped `GoblinHorde-Team.zip`, the same version the host has. Set the host up first with [SHARED-HOST-PROMPT.md](SHARED-HOST-PROMPT.md). What a shared game is, and how to undo this, is in [SHARED-PETS.md](SHARED-PETS.md).

```
Make this computer a display of my shared Goblin Horde pet game. Another computer hosts the game.
Work in the unzipped GoblinHorde folder. Read AGENTS.md and docs/SHARED-PETS.md there first.
1. Run: node goblin.mjs doctor
   Tell me what is missing. Do not install Node.js, Python, Tailscale, or T3 Code yourself.
2. Install or update without starting: node goblin.mjs install --no-start
   Use the installed manager from here on.
3. Ask me for the host's Tailscale address and port, as pets-host status printed them there, and
   for the path of a text file with the host's pairing code. Do not open, print, or copy that file.
4. Run: pets-join --host <address>:<port> --code-file "<path>"
   If it prints a problem, report the problem as worded and stop. It saved nothing on this computer.
5. Run: stop, then start. Goblin Horde picks its own game or the host's when it
   starts, so one that is already running must be stopped first.
6. Read http://127.0.0.1:43917/api/pets and report ready, the coins, and the number of goblins.
   They are the host's numbers, and I will compare them with the host's report. If ready is
   false, report the message as worded.
7. Tell me to delete the text file with the code, and to look at the taskbar for the goblins.
Never print or send the pairing code, remote-code.txt, a token, or chat text. Copy no file
between computers, and change no other setting.
To undo this later: pets-join --off, then stop, then start.
```

A `pets-join` that prints a problem has saved nothing on this computer. Its check pairs with the host, so a check that got as far as pairing leaves this computer a session on the host. That session ends after a day, or sooner when the host turns sharing off.

The pairing code goes from this computer to the host's Tailscale address when it pairs, and nowhere else. It is kept in `remote-code.txt` in this computer's state folder, which only your account can read. If Goblin Horde says that file could not be made private, it shows no game: run `pets-join` again, which writes the file anew.
