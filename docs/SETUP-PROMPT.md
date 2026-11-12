# Setup prompt for the pet game

Copy the block below and give it to a coding agent (Codex or Claude Code) on the Windows computer that should run the game. Start the agent in the folder that holds the unzipped `GoblinHorde-Team.zip`, or in any empty folder to have it clone the repository.

```
Set up the Goblin Horde pet game on this Windows computer.

1. Get the package. If the current folder holds an unzipped GoblinHorde-Team.zip (a GoblinHorde
   folder with goblin.mjs in it), use that folder. Otherwise run:
   git clone -b goblin-pets https://github.com/epoisel/goblin-horde
2. In the package folder, read AGENTS.md and follow "Install the pet game".
3. Run: node goblin.mjs doctor
   Tell me what is missing. Do not install Node.js, Python, or T3 Code yourself.
4. If doctor shows no blocker, run: node goblin.mjs install --no-claude-hooks --surface pets
5. Report back: what is missing, whether install printed "The desktop goblins are running.",
   and how many coins and goblins http://127.0.0.1:43917/api/pets shows.

Work only in the package folder. Let the installer write its own app folder and state folder.
Change no other setting, do not turn on phone access, and send no file anywhere.
```
