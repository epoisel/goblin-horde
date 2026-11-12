# Host prompt for a shared pet game

Copy the block below and give it to a coding agent (Codex or Claude Code) on the Windows computer where T3 Code runs its turns. Start the agent in the folder that holds the unzipped `GoblinHorde-Team.zip`. What a shared game is, and what the host checks, is in [SHARED-PETS.md](SHARED-PETS.md).

```
Make this computer the host of my shared Goblin Horde pet game. T3 Code runs its turns here.
Work in the unzipped GoblinHorde folder. Read AGENTS.md and docs/SHARED-PETS.md there first.
1. Change nothing yet. Run: node goblin.mjs status, node goblin.mjs pets-host status, node goblin.mjs doctor
   Tell me if Goblin Horde is installed and if a saved game exists, as counts only. If pets-host status
   says another Goblin Horde holds the saved game, stop here and report it.
2. Install or update without starting: node goblin.mjs install --no-start
   It keeps the state folder and any saved game. Never run uninstall, and never use --remove-settings.
3. Use the installed manager from here on. Only if step 1 found no saved game and I gave you the path
   of a pets.json to bring over, run: pets-adopt "<that path>". With a saved game here, keep it.
4. Run: pets-host enable, then start --surface pets, then doctor, then pets-host status.
5. Prove it earns. Read coins and seq from http://127.0.0.1:43917/api/pets and tell me them.
   Ask me to finish one turn in T3 Code on this computer, and wait until I say it is done.
   Read /api/pets?after=<that seq>. The new seq must be higher, with one "work" event whose coins
   are above 0. Read it twice more, 10 seconds apart. The coins must have risen once and stayed.
6. Report what doctor found, the counts, the proof from step 5, and the Tailscale address and port
   that pets-host status says another computer joins at.
Never print, open, or send the pairing code, pairing-code.txt, a token, chat text, or T3 Code data.
I read the code myself with pets-host code. Copy no file between computers, and change no other setting.
```

If a port other than 43917 is in use, read that port in step 5.

The host needs the `tailscale` program that Tailscale installs. If `pets-host enable` says that program was not found, or that Tailscale is not connected, install or open Tailscale, sign in, and run the prompt again: the host does not listen until then. If `pets-host` says a Goblin Horde holds the saved game and did not answer, it changed nothing. Stop Goblin Horde and try again. `pets-host status` and `pets-adopt` can take 20 seconds when a lock on the saved game was left behind, because they watch it before they say who holds the game.

The host asks Tailscale for its address when its listener opens, which every start of Goblin Horde does, and again every 60 seconds. If Tailscale gives the computer another address, the listener closes within a minute, and `pets-host status` says to run `pets-host enable` again.

If `pets-host status` says a file could not be made private, the host is not listening: sharing stays off until `pairing-code.txt` and `shared.json` can be read by your account alone. If step 5 reads `ready: false` with "The saved game could not be read. A copy was kept next to it. Nothing was replaced.", no game was started in its place. The agent should report that as worded and change no file. What happens to the saved game is yours to decide.

The pairing code is shown in two places only, both on the host: `pets-host code` in a terminal you sit at, and the phone pairing page while phone access is on. A display sends it to the host when it pairs, to the host's Tailscale address and nowhere else.
