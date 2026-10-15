/**
 * Which Orca terminals a command line directs: `orca orchestration dispatch --to term_…`, `orca terminal
 * send --terminal term_…`, and the other orchestration verbs that address a terminal. Shared by the
 * Codex party links (lib/links.mjs) and the Claude Code hook (lib/claude.mjs), which records these
 * before its credential filter blanks long ids such as terminal handles. No dependencies.
 */
export const ORCA_HANDLE_TEXT = "term_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMMAND = /\borca(?:\.exe)?\s+(orchestration|terminal)\s+([a-z][a-z-]*)([^|;&\n]*)/gi;
const ADDRESSED = new RegExp(String.raw`--(terminal|from|to)[ =]+["']?(${ORCA_HANDLE_TEXT})`, "g");
// Terminal subcommands that only look at a terminal; a chat looks at many it does not drive.
const OBSERVING = new Set(["read", "show", "list", "switch", "close"]);

/**
 * The Orca terminals one command line addresses with a driving verb: [{ terminal, verb, flag }], where
 * `verb` is "orchestration dispatch", "terminal send", … and `flag` the flag that named the terminal
 * ("terminal", "to", or "from"). Commands that only look at a terminal are left out. Pure.
 */
export function commandTerminals(command) {
  if (typeof command !== "string" || !command.includes("orca")) return [];
  const found = [];
  for (const match of command.slice(0, 65_536).matchAll(COMMAND)) {
    const [, kind, verb, rest] = match;
    if (kind.toLowerCase() === "terminal" && OBSERVING.has(verb.toLowerCase())) continue;
    for (const flag of rest.matchAll(ADDRESSED)) found.push({ terminal: flag[2], verb: `${kind} ${verb}`.toLowerCase(), flag: flag[1].toLowerCase() });
  }
  return found;
}
