# Contributing to Goblin Horde

Thanks for helping. Goblin Horde is small and has no package dependencies, so getting set up is quick.

## What you need

- **Node.js 20 or newer.** The manager, viewer server, Claude Code hook receiver, and Node tests use only the standard library. There is no `npm install` step.
- **Python 3 with Tkinter (Tk 8.6+)** for the desktop widget and the Python tests. Optional if you only work on the browser viewer or the manager.
  - Windows: the python.org installer includes Tkinter.
  - macOS: python.org Python, or Homebrew `python` plus `python-tk`. Apple's `/usr/bin/python3` ships an older Tk that the widget refuses.
  - Linux: your distribution's `python3-tk` package. The transparent widget does not run on Linux, but most Python tests do.

## Run it from a checkout

```
node server.mjs                 # browser viewer at http://127.0.0.1:43917
node goblin.mjs doctor          # see what this computer has; changes nothing
```

On Windows, `.\start.ps1` and `.\start_goblins.ps1` start the viewer and the desktop widget from this folder. **Party demo** in the viewer shows simulated parties without reading any real chats.

## Tests

```
npm test                                         # Node tests (node --test)
python -m unittest discover -s test -p "test_*.py"   # Python tests, from the repository root
```

Both use temporary folders. They never read or change your real Claude Code settings and never start the viewer. Some Python tests build real Tk windows; they run only on Windows and skip elsewhere. CI runs both suites on Windows, macOS, and Linux and requires both to pass on all three, including the Windows Python tests that build Tk windows (see `.github/workflows/ci.yml`). CI cannot check how the desktop widget looks or behaves on screen; no hosted runner validates on-screen transparency on macOS.

If you change anything the installed app needs at runtime, add the file to `package-files.json`. `node scripts/package.mjs` builds `dist/GoblinHorde-Team.zip` from that list and refuses to build if a listed file looks like local state or contains a personal path, e-mail address, or credential.

## Issues

Say what you expected, what happened, your operating system, `node --version`, and (for the widget) your Python and Tk version. `node goblin.mjs doctor` output is useful, but read it first and remove anything personal.

## Pull requests

- Keep each pull request to one change, and explain why it is needed.
- Add or update tests for behavior changes. `npm test` and the Python tests must pass.
- Update `README.md` when what users see or do changes.
- For widget changes, say which systems you tried it on. If you could not try it on a real Mac, say so; please do not describe macOS behavior as verified unless it was.
- Contributions are accepted under the MIT license in `LICENSE`. Only submit code, art, and text you have the right to contribute.

## Privacy

Goblin Horde shows other people's and your own agent activity, so test material can leak easily. In issues, pull requests, tests, fixtures, and screenshots, **never include**:

- real chat or session contents, prompts, or agent replies;
- pairing codes or session cookies;
- Claude Code settings files, Goblin Horde state files, or recorded activity files;
- API keys, tokens, or other credentials;
- logs or paths that contain your user name, home folder, or other personal details.

Use invented data (the `Party demo` and the existing test fixtures show the style: `C:\Users\you`, `/Users/Jane Smith`, `example.com`). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
