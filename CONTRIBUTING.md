# Contributing to Goblin Horde

Thanks for helping. Goblin Horde is small and has no package dependencies, so there is no `npm install` step.

## What you need

- **Windows.** The pet game runs on Windows only.
- **Node.js 22.13 or newer.** The manager, the local server, and the Node tests use only the standard library. The game reads T3 Code's database with the SQLite built into Node.js.
- **Python 3 with Tkinter (Tk 8.6+)** for the desktop widget and the Python tests. The python.org installer includes Tkinter.

## Run it from a checkout

```
node goblin.mjs doctor          # see what this computer has; changes nothing
node scripts/dev/pets-rig.mjs   # the game in a sandbox, with a fixture T3 Code database
```

`scripts/dev/README.md` describes the sandbox tools. They never read your real T3 Code database or your saved game.

## Tests

```
npm test                                             # Node tests (node --test)
python -m unittest discover -s test -p "test_*.py"   # Python tests, from the repository root
```

Both use temporary folders. They never read or change your real settings and never start the game. Some Python tests build real Tk windows. CI runs both suites (see `.github/workflows/ci.yml`). CI cannot check how the goblins look or move on screen.

If you change anything the installed app needs at runtime, add the file to `package-files.json`. `node scripts/package.mjs` builds `dist/GoblinHorde-Team.zip` from that list and refuses to build if a listed file looks like local state or contains a personal path, e-mail address, or credential. `node scripts/dev/clean-install.mjs` installs that ZIP into a temporary folder and checks that the game loads from the installed copy.

## Issues

Say what you expected, what happened, your Windows version, `node --version`, and your Python and Tk version. `node goblin.mjs doctor` output is useful, but read it first and remove anything personal.

## Pull requests

- Keep each pull request to one change, and explain why it is needed.
- Add or update tests for behavior changes. `npm test` and the Python tests must pass.
- Update `README.md` when what users see or do changes.
- For widget changes, say which displays and scaling you tried it on.
- Contributions are accepted under the MIT license in `LICENSE`. Only submit code, art, and text you have the right to contribute.

## Privacy

Test material can leak private data easily. In issues, pull requests, tests, fixtures, and screenshots, **never include**:

- real chat contents, prompts, or agent replies, or a copy of a real T3 Code database;
- pairing codes or session cookies;
- Goblin Horde state files, such as `pets.json`, `shared.json`, `remote.json`, or anything from the `run` logs folder;
- API keys, tokens, or other credentials;
- logs or paths that contain your user name, home folder, or other personal details.

Use invented data. The existing test fixtures show the style: `C:\Users\you` and `example.com`. Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
