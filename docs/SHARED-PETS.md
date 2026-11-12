# One pet game on several computers

The pet game pays coins for work that finishes in T3 Code on the computer it runs on. If T3 Code runs its turns on one computer and you sit at another, the game on your computer never earns. A shared game fixes that: one computer runs the game, and your other computers show it over [Tailscale](https://tailscale.com).

## The two roles

- **The host** is the computer where T3 Code runs its turns. It reads its own T3 Code database, keeps the only saved game (`pets.json`), and pays the coins. When you turn sharing on, it also listens on its own Tailscale address.
- **A display** is any other computer on your tailnet. Its goblins are the host's horde. A purchase or a fight on a display happens on the host. A display reads no T3 Code database and opens no saved game. A `pets.json` it had before stays on its disk, unused.

A computer is a host or a display, never both. No T3 Code database, sign-in, or session file is copied between computers. What crosses the connection is this, and nothing else:

- **From a display to the host:** the pairing code when it pairs, the session that pairing earned, the number of the last event it has shown, and each game action it asks for, which is the kind of a purchase or the number of a boss to fight.
- **From the host to a display:** the game's numbers, true and false, the day, the eight letters and digits that name the host's run, and short codes from fixed lists. A code says why a game is not ready, why work is not being counted, or why a purchase or a fight was not done.

No sentence crosses. A display says each code in its own words, and a sentence a host sends is never shown. For an answer with a sentence and no code, as a host of an older version sends, a display shows its own plain sentence and none of the host's words. The host cuts each answer down to those fields before it sends it, and a display cuts it down again before it shows it. An answer that holds the pairing code is not sent and not shown, however the code is spelled in it: with spaces or dashes between its letters, in small letters, or run on across fields that follow one another.

Both computers need Windows, Tailscale signed in to the same account, and the same version of Goblin Horde. The host needs Node.js 22.13 or newer, and it needs the `tailscale` program that Tailscale installs, because that program is what tells the host its own Tailscale address and who is calling.

## Set up the host

Run these with the installed manager, on the computer where T3 Code runs. To have a coding agent do it, give it [SHARED-HOST-PROMPT.md](SHARED-HOST-PROMPT.md).

1. To start from a saved game made on another computer, copy that `pets.json` here yourself and run `pets-adopt <path>` before the game first starts here. Skip this step to keep the host's own game or to begin a new one.
2. Run `pets-host enable`. If it says Tailscale's program was not found, or that Tailscale is not connected, fix that first: the host does not listen until Tailscale itself names the address.
3. Run `start`.
4. Run `pets-host status`. It prints the address and port that displays join at.
5. Run `pets-host code` in a terminal yourself. It prints the pairing code.

## Join from a display

To have a coding agent do it, give it [SHARED-JOIN-PROMPT.md](SHARED-JOIN-PROMPT.md).

1. Save the pairing code in a text file. The code is never typed on a command line.
2. Run `pets-join --host <address>:<port> --code-file <file>`. Write the address as Tailscale shows it, four plain numbers such as 100.101.102.103, or give the host's MagicDNS name. It asks the host for a health check and a pairing first. If either fails it says why and saves nothing on this computer. The check pairs with the host, so a check that got as far as pairing leaves this computer a session on the host. That session ends after a day, or sooner when the host turns sharing off.
3. Run `stop`, then `start`. Goblin Horde chooses between its own game and a host's when it starts, so a Goblin Horde that was already running keeps its own game until you stop it. The goblins are now the host's.
4. Delete the text file.

## What the host checks

The shared listener is a server of its own. It is off until `pets-host enable`, and it listens on the host's Tailscale address only, never on Wi-Fi and never on every address. The host's own `tailscale` program must name that address. Without the program, or while it does not answer, nothing listens: no adapter's name or address is taken for Tailscale's.

The address is asked for when the listener opens, which every start of Goblin Horde does, and again every 60 seconds while the listener is open. It is not watched in between. If Tailscale gives the computer another address, the listener closes at the next check, the log in the state folder's `run` folder says why, and `pets-host status` says to run `pets-host enable` again. For up to a minute after such a change the listener is still bound to the old address.

Each request must pass all of these checks, or the host refuses it.

| Check | What passes |
|---|---|
| Network | The caller's address, as its connection reports it, is in Tailscale's range (100.64.0.0/10 or fd7a:115c:a1e0::/48). A forwarded-for header is never read. |
| Address asked for | The request names the host by its Tailscale address or MagicDNS name. A web page that reaches the host under another name is refused. |
| Route | Only five routes exist here: pair, read the game, buy, fight, and a health check. No other route of the local server does. A route is the request's path exactly as it was sent, so no other spelling of a path reaches one. |
| Tailscale account | `tailscale whois` says the caller is signed in to the same account as the host. A shared-in or tagged device fails. Every request is checked, and a lookup that fails is a refusal. |
| Page | A request that changes anything comes from the listener's own address, so a web page cannot buy goblins for you. |
| Pairing | The caller holds a session it earned with the pairing code. Five wrong codes from one address close pairing to that address for ten minutes. One address holds one session. A computer that is signed in and gives the code again is answered the session it has, so every program on that computer shares one session, and a join check never signs a running display out. |

A display that passes can read the game, buy, and fight. It can do nothing else.

Know these limits:

- The host shares only while Goblin Horde runs there. After the host restarts, run `start` on it again. If Tailscale connects after Goblin Horde starts, the listener opens by itself within half a minute.
- The pairing code leaves a computer in one way only: a display sends it to its host when it pairs, and only to an address it has checked is on your tailnet. Nothing the host sends to another computer holds the code, and no log does.
- The pairing code is shown on a screen in one place only, on the host itself. `pets-host code` prints it in a terminal there with you at it.
- The files that hold the code and the switch are private to your account: `pairing-code.txt` and `shared.json` in the host's state folder, and `remote-code.txt` in a display's. A file that an older version or another program left readable by other accounts is made private before the host's listener opens, and before a display reads its code. If a file cannot be made private, the host does not listen and the display shows no game, and each names the file.
- The host needs the `tailscale` program. Without it `pets-host enable` refuses, a listener that was turned on earlier stays closed, and `pets-host status` and `doctor` say why.
- The listener speaks plain HTTP. Tailscale encrypts the traffic between your computers. Do not put a proxy or a port forward in front of the listener.
- Anyone who is signed in to your Tailscale account, on a computer that has the pairing code, can play your game.

## Commands

Run each with the installed manager, for example `node "%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs"`.

| Command | What it does |
|---|---|
| `pets-host enable` | Turns sharing on and saves this computer's Tailscale address in `shared.json`. A running game starts to listen at once. It refuses when the `tailscale` program is not found or names no address. |
| `pets-host disable` | Asks the Goblin Horde that runs on this state folder to close its listener and sign every display out. It says they are signed out only when that Goblin Horde answers all three things: sharing is off, nothing listens, and no session is left. With none running it saves the choice. |
| `pets-host status` | Prints whether it listens, the address and port to join at, the number of paired sessions, and the saved game as counts. Never the code. |
| `pets-host code` | Prints the pairing code, only in a terminal on this computer. Anywhere else it refuses and names the file you can open yourself. |
| `pets-join --host <address>[:port] --code-file <file>` | Makes this computer a display of that host. `--code-stdin` reads the code from standard input. The port is 43917 unless you name one. |
| `pets-join --off` | Makes this computer play its own game again. |
| `pets-adopt <path> [--replace]` | Makes a saved game from another computer this computer's own. See below. |
| `doctor` | Its **Shared game** lines say whether Tailscale is connected, this computer's address, whether the login check works, and whether this computer hosts or shows a game. |

`pets-host enable` and `pets-host disable` work through the Goblin Horde that is running, wherever it runs: they find it by the lock it holds on the saved game. If a Goblin Horde holds the saved game and does not answer, or does not finish its answer in time, they change nothing and say so. Try again in a moment, or run `stop` first. A listener also reads `shared.json` again before every answer and every few seconds, so a listener never goes on serving after sharing was turned off.

A `shared.json` that cannot be read is not an off, because that is what a file looks like in the middle of a write. The last choice that could be read stands for 30 seconds, while the file is read again every second. After 30 seconds sharing is off and every display is signed out. The listener opens again by itself once the file can be read and says on.

`pets-join` sends the pairing code only to a Tailscale address or to a name that resolves to one. It refuses an address written any other way than four plain numbers, such as a hexadecimal number, and it refuses a name made only of digits and the letters a to f and x, which could be read as a number. Use the full MagicDNS name for a computer with such a name.

`pets-adopt` takes only the numbers and the day of the saved game format from the file, and each must be a value a game can reach. A count of bosses cleared that is higher than this game has is held to the bosses there are. It saves the moment of adoption in the saved game as a cutoff: work that finished in T3 Code on this computer at or before that moment is never paid, even when T3 Code could not be read then or writes the row later. No coins are added for time away.

The file must be an ordinary file on this computer's own disk, named by its real path. These are refused: a network share, a drive letter or a folder that stands for a share, a device, a folder, a link, a path that goes through a link or a junction in any folder above the file, a file over 1 MB, and this computer's own saved game under another name. `pets-adopt` refuses while Goblin Horde runs. It refuses when this computer already has a saved game, unless you add `--replace`, which first keeps the present one in the state folder as `pets.json.before-adopt-<time>` with a few random letters after the time. Each replacement keeps its own copy, and no copy is written over.

## The saved game and its one writer

A saved game is never replaced by a new game. A game that was saved when there were more bosses still opens when there are fewer, with its bosses cleared held to the bosses there are. If `pets.json` cannot be read and its backup `pets.json.bak` can, the game goes on from the backup, and the file that could not be read is kept beside it as `pets.json.unreadable.<time>-<letters>`. If neither can be read, no game starts. The game says "The saved game could not be read. A copy was kept next to it. Nothing was replaced." and writes nothing, until you move the files away yourself. Each kept copy has a name of its own, is private to your account, and is never written over. A new game begins only in a state folder with no `pets.json` and no `pets.json.bak`.

Only one Goblin Horde may write a game in a state folder. That is enforced by a lock with a heartbeat. The one that runs the game holds `pets.lock` there, touches it every five seconds, and asks whether the lock is still its own right before each file of a save is put in place. A second one says "Another Goblin Horde on this computer already runs the game." and saves nothing. A lock that has shown whoever watches it no heartbeat for 20 seconds is free, so a Goblin Horde that crashed does not hold the game for long. The 20 seconds are counted on the watcher's own clock, and the date on the file is never read as a time, so a wrong or changed computer date neither keeps a lock nor frees one. Whoever asks for the lock watches it first, because one look cannot tell a holder that runs from one that is gone. A holder that runs shows its heartbeat within five seconds. So a second Goblin Horde says that it is opening the game for a few seconds before it says another one runs it, and a lock that somebody left behind is taken over after 20 seconds. `pets-adopt` and `pets-host status` can take that long for the same reason. When Goblin Horde stops, it gives the lock up only after its last save has landed.

This is not a lock of the operating system. A writer that is frozen for more than 20 seconds in the instant between its last look at the lock and the rename of its file could, in theory, still overwrite a newer save. Only an operating-system lock would close that.

## Undo it

- On a display, run `pets-join --off`, then `stop` and `start`. The display opens its own saved game again.
- On the host, run `pets-host disable`. It signs every display out, and the game goes on as an ordinary pet game on that computer.
- To go back to the saved game from before an adoption, stop Goblin Horde and run `pets-adopt` with the `pets.json.before-adopt-<time>` file and `--replace`.

See [SECURITY.md](../SECURITY.md) for what is in scope for a security report.
