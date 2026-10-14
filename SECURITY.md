# Security policy

Goblin Horde runs on your own computer and shows agent activity from local sources. Some of that activity can be private, so we take reports about exposure seriously.

## Reporting a vulnerability

Please report privately first:

1. **Preferred:** use GitHub's private vulnerability reporting for this repository (**Security** tab → **Report a vulnerability**) once it is enabled.
2. **If that option is not available yet:** open a regular issue titled "Security contact request" that says only which area is affected (for example "phone pairing" or "Claude Code hook receiver"). **Do not include** exploit details, proof-of-concept code, or real data. A maintainer will reply with a private way to share the details.

Please give us a reasonable chance to fix the problem before disclosing it publicly. There is no bug bounty.

Supported version: the latest code on the default branch. Older ZIP packages are not patched separately; reinstall from current source.

## In scope

- **Local network phone pairing.** Phone access is off by default: the viewer listens only on `127.0.0.1` until the person turns phone access on (`phone.json` in the state folder). Then it also listens on one private Wi-Fi address (or `LAN_IP`, honoured only while phone access is on), skipping VPN and virtual adapters and, on Windows, networks marked Public, with pairing required. A paired phone can read the listed chats, send replies, and approve or decline Codex requests; it can never turn phone access on or off, make a new pairing code, change Claude Code settings, or change sign-in startup. Turning phone access off or making a new pairing code signs every phone out. Relevant issues include bypassing the 8-character pairing code or its attempt limit (five failures per address per ten minutes), session cookie theft or fixation, the pairing code being exposed to non-local requests, Host or Origin checks that let another site or device read chats or send replies, a phone reaching a local-only route, any listener on a non-loopback address while phone access is off, and the server binding to a public address.
- **Source adapters.** How Goblin Horde reads Codex (`codex app-server`), Claude Code hooks (`claude-hook.mjs` and the recorded activity file), Orca (`orca` CLI snapshots), and extension feeds (`EXTENSIONS.md`). Relevant issues include recording or displaying data the README says is not shown (for Claude Code: tool output, file contents, error text; for every source: reasoning; on a phone: command output, tool arguments, and the text of what an agent asks, is running, or plans, of which a phone gets only kinds, counts, and times), the viewer reading an agent's transcript or chat records for anything but showing that agent on this computer, credential-like text passing the redaction that every text field goes through before it is recorded or leaves the server, an extension feed injecting raw commands or markup into the viewer or widget, and path or file name handling that reads or writes outside the Goblin Horde state folder.
- **Reply sending.** A paired device or web page causing replies to be sent to a Codex chat it should not reach.
- **Install, hooks, and uninstall.** The manager editing Claude Code settings beyond its own entries, stopping processes that are not this installation's own, or removing files outside its own install and state folders.
- **Packaging.** `scripts/package.mjs` letting local state, personal paths, or credentials into the ZIP.

## Out of scope / known limits

- **Plain HTTP on the local network.** Phone pairing uses HTTP, not HTTPS. Anyone who can watch traffic on the same network may see the pairing code or session cookie. Use phone pairing only on a network you trust; this is documented, not a vulnerability by itself.
- Anyone with the pairing code and network access, while phone access is on, can view the listed chats, send replies, and answer Codex approvals. That is the intended design; turn phone access off or make a new pairing code to end it.
- **Other programs and accounts on the same computer are trusted.** "This computer" means a connection from `127.0.0.1`: any local process, including one running as another Windows, macOS, or Linux account on the same machine, can use the viewer the way you can, including the local-only routes. Multi-user computers (shared PCs, terminal servers) are out of scope for now; run Goblin Horde only on a computer whose other accounts you trust.
- The credential filter recognises common shapes (key=value pairs, password flags, well-known token prefixes, long random strings). A secret in an unusual shape can pass it; on this computer such text is visible to you (and a Claude Code command or prompt excerpt that held it is kept in the local activity file), and on a phone command output, tool arguments, and the text of asks, current steps, and plans are left out entirely.
- Attacks that require an attacker already running code as your user on the computer, or control of your Codex, Claude Code, or Orca installation.
- Problems in Codex, Claude Code, Orca, Node.js, Python, or Tk themselves. Report those to their maintainers.

## Handling report data

Do not send real chat contents, pairing codes, Claude Code settings, tokens, or logs with personal paths, even privately, unless a maintainer specifically asks for something and you are comfortable sharing it. Invented data that reproduces the problem is almost always enough.
