# Security policy

Goblin Horde runs on your own computer and shows agent activity from local sources. Some of that activity can be private, so we take reports about exposure seriously.

## Reporting a vulnerability

Please report privately first:

1. **Preferred:** use GitHub's private vulnerability reporting for this repository (**Security** tab → **Report a vulnerability**) once it is enabled.
2. **If that option is not available yet:** open a regular issue titled "Security contact request" that says only which area is affected (for example "phone pairing" or "Claude Code hook receiver"). **Do not include** exploit details, proof-of-concept code, or real data. A maintainer will reply with a private way to share the details.

Please give us a reasonable chance to fix the problem before disclosing it publicly. There is no bug bounty.

Supported version: the latest code on the default branch. Older ZIP packages are not patched separately; reinstall from current source.

## In scope

- **Local network phone pairing.** The viewer listens on `127.0.0.1` and, when it finds a private Wi-Fi address (or `LAN_IP` is set to a private IPv4 address), on that address too, with pairing required. Relevant issues include bypassing the 8-character pairing code or its attempt limit (five failures per address per ten minutes), session cookie theft or fixation, the pairing code being exposed to non-local requests, Host or Origin checks that let another site or device read chats or send replies, and the server binding to a public address.
- **Source adapters.** How Goblin Horde reads Codex (`codex app-server`), Claude Code hooks (`claude-hook.mjs` and the recorded activity file), Orca (`orca` CLI snapshots), and extension feeds (`EXTENSIONS.md`). Relevant issues include recording or displaying data the README says is never recorded (prompts, tool inputs and outputs, command text, transcripts, reasoning), credential-like text passing the redaction, an extension feed injecting raw commands or markup into the viewer or widget, and path or file name handling that reads or writes outside the Goblin Horde state folder.
- **Reply sending.** A paired device or web page causing replies to be sent to a Codex chat it should not reach.
- **Install, hooks, and uninstall.** The manager editing Claude Code settings beyond its own entries, stopping processes that are not this installation's own, or removing files outside its own install and state folders.
- **Packaging.** `scripts/package.mjs` letting local state, personal paths, or credentials into the ZIP.

## Out of scope / known limits

- **Plain HTTP on the local network.** Phone pairing uses HTTP, not HTTPS. Anyone who can watch traffic on the same network may see the pairing code or session cookie. Use phone pairing only on a network you trust; this is documented, not a vulnerability by itself.
- Anyone with the pairing code and network access can view the listed chats and send replies. That is the intended design.
- Attacks that require an attacker already running code as your user on the computer, or control of your Codex, Claude Code, or Orca installation.
- Problems in Codex, Claude Code, Orca, Node.js, Python, or Tk themselves. Report those to their maintainers.

## Handling report data

Do not send real chat contents, pairing codes, Claude Code settings, tokens, or logs with personal paths, even privately, unless a maintainer specifically asks for something and you are comfortable sharing it. Invented data that reproduces the problem is almost always enough.
