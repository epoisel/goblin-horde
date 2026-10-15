/**
 * Direct Claude Code activity, recorded by a hook and read back as goblin parties.
 *
 * The person on this computer sees what each Claude Code agent is doing, which Claude Code itself
 * folds away: the hook records which tool ran, what it worked on (the command, the full file path, the
 * search pattern, the url, the subagent's description), the questions it asks and their options, its
 * todo list, an excerpt of each prompt and final reply, what a needs-you notification says, and where
 * the session's transcript is. Every
 * text passes the credential filter (redactSecrets) and is clipped before it is written. Tool output,
 * file contents, error text, and reasoning are never recorded; a transcript is read here only for the
 * model id (the detail view reads it, locally, for agents on screen, and a session in view is named from
 * the title records at its end and its first prompt, see ClaudeTitleReader). Records stay in Goblin Horde's own
 * state folder; a paired phone only ever gets the summaries (see public-view.mjs). Records are rebuilt
 * into Codex-shaped actors, with what each asks the person (`ask`), what it is doing (`now`), and how
 * far its plan is (`progress`), so the widget and viewer need no Claude-specific code.
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { cleanModelId, describeModel } from "./models.mjs";
import { closingQuestion, firstLine, hostOf, makeAsk, makeNow, planProgress } from "./asks.mjs";
import { ORCA_HANDLE_TEXT, commandTerminals } from "./orca-commands.mjs";

export const CLAUDE_LIMITS = Object.freeze({
  rotateBytes: 1_000_000, // The live log rolls over to one older file at this size.
  lineChars: 16_384, // A stored line longer than this is not one of ours. A full todo list fits well inside.
  detailChars: 400, // The command, path, pattern, url, or description a tool call works on.
  promptChars: 600, // Prompt excerpt.
  questionChars: 600, // A reply's closing question, with the sentence before it.
  todos: 30, // Todo items kept from one TodoWrite.
  todoChars: 200,
  records: 6000, // Newest records rebuilt per read.
  sessions: 100, // Claude sessions kept as parties: needing you, failed, working, then newest.
  children: 24, // Subagents kept per session, in the same order; what is cut is counted.
  activities: 40, // Public steps kept per goblin.
  turns: 3, // Turn states kept per goblin, as for Codex.
  excerptChars: 600, // Final reply excerpt.
  noticeChars: 300, // What a needs-you notification says ("Claude needs your permission to use Bash").
  catalogMs: 7 * 24 * 60 * 60_000, // Sessions older than this leave the source list.
  staleMs: 2 * 60 * 60_000, // A turn with no hook for this long is no longer called working.
  // A turn with no tool call open and no hook for this long is idle, not working: the person most likely
  // pressed Esc or closed the terminal, and Claude Code sent no idle notice. An open call (a long test
  // run) stays "Running …" until staleMs.
  idleMs: 10 * 60_000,
  // An open Bash or PowerShell call with no hook for this long is over too: Claude Code's shell tool stops
  // a command at ten minutes, so the session was closed or interrupted mid-command.
  shellMs: 12 * 60_000,
  doneMs: 2 * 60_000, // A step that just finished names the goblin's line this long; then it reads "Thinking".
  namesMs: 24 * 60 * 60_000, // Sessions active this recently may be named from their transcript (the scene's window).
  askMs: 6 * 60 * 60_000, // A permission or question prompt stays urgent this long.
  // A permission request alone asks this long. Claude Code sends its own notice when the dialog is still
  // open after about six seconds; that confirms it. Approval sends nothing until the tool finishes.
  unconfirmedMs: 10_000,
  failedMs: 30 * 60_000, // A failure stays urgent this long after the session's last activity; then the person has moved on.
});

const EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "Stop", "StopFailure"]);
const NEEDS_NOTICES = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);
// Notices that say a permission dialog is still waiting on the person.
const CONFIRM_NOTICES = new Set(["permission_prompt", "agent_needs_input"]);
const CLEAR_NOTICES = new Set(["elicitation_complete", "elicitation_response"]);
// Claude Code is back at its prompt, waiting for the next message. Stop does not run when the person
// interrupts a turn (Esc) or denies a permission, so this is the only sign that such a turn is over.
const IDLE_NOTICE = "idle_prompt";
const START_SOURCES = new Set(["startup", "resume", "clear", "compact", "fork"]);
const END_REASONS = new Set(["clear", "resume", "logout", "prompt_input_exit", "other"]);
const ERROR_TYPES = new Set(["rate_limit", "overloaded", "authentication_failed", "oauth_org_not_allowed", "account_on_hold",
  "billing_error", "invalid_request", "model_not_found", "server_error", "max_output_tokens", "cloud_credential_error", "unknown"]);
const ERROR_TEXT = {
  rate_limit: "Claude Code hit a rate limit.", overloaded: "Claude was overloaded.", server_error: "Claude hit a server error.",
  authentication_failed: "Claude Code needs to sign in again.", max_output_tokens: "The reply ran out of room.",
  billing_error: "Claude Code reported a billing problem.", account_on_hold: "The Claude account is on hold.",
  invalid_request: "Claude rejected the request.", model_not_found: "Claude Code could not find the chosen model.",
  oauth_org_not_allowed: "This Claude organization is not allowed here.", cloud_credential_error: "Claude Code's cloud credentials failed.",
};
const FILE_TOOLS = { Read: "read", NotebookRead: "read", Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit" };
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
// Tools whose run_in_background starts the work and returns at once.
const BACKGROUND_TOOLS = new Set(["Agent", "Task", "Bash", "PowerShell"]);
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);
const TODO_STATES = new Set(["pending", "in_progress", "completed"]);
const TASK_STATES = new Set(["pending", "in_progress", "completed", "deleted"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// File names that suggest secrets are shown without their name.
const PRIVATE_NAME = /^\.env(\.|$)|^\.netrc$|^\.npmrc$|^\.pypirc$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks)$|secret|credential|password|token/i;

const clip = (value, max) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const safeId = (value) => (typeof value === "string" && SAFE_ID.test(value) ? value : "");
const safeLabel = (value, max = 40) => (typeof value === "string" ? clip(value.replace(/[^A-Za-z0-9 _.:-]/g, ""), max) : "");
const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 4);

/** Where Goblin Horde keeps its own state on this computer. */
export function goblinStateDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const path = platform === "win32" ? win32 : posix;
  if (env.GOBLIN_HORDE_STATE_DIR && path.isAbsolute(env.GOBLIN_HORDE_STATE_DIR)) return env.GOBLIN_HORDE_STATE_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "GoblinHorde");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "GoblinHorde");
  const xdg = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return path.join(xdg, "goblin-horde");
}

export function claudeActivityDir(options) {
  const platform = options?.platform || process.platform;
  return (platform === "win32" ? win32 : posix).join(goblinStateDir(options), "claude");
}

// A key that names a credential, alone or at the end of a longer name: password, db_password,
// clientSecret, x-api-key, accessToken, AWS_SECRET_ACCESS_KEY. "max_tokens" or "token_count" are not.
// Azure's AccountKey, SharedAccessKey, and SharedAccessSignature are named too: their values hold
// "/" and "+", which the long-run catch-all at the end does not cover.
const CREDENTIAL_WORD = String.raw`(?:password|passwd|passphrase|pwd|secrets?|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|private[_-]?key|auth[_-]?key|access[_-]?signature|credentials?|authorization|cookie)`;
// In key = value pairs, also keys that end in a key some owner keeps secret (secret_key, signingKey,
// Ocp-Apim-Subscription-Key) and in a pass: passcode, and db_pass, DB_PASS, or smtpPass, where "pass"
// is a word of its own (bypass, compass, and "pass: 42" are not; see passKey).
const PAIR_WORD = String.raw`(?:${CREDENTIAL_WORD.slice(3, -1)}|(?:secret|signing|encryption|client|master|storage|shared|subscription)[_-]?key|passcode|pass)`;
// keytool and jarsigner name theirs -storepass and -keypass (-storepass:env NAME says where it is, and stays).
const FLAG_WORD = String.raw`(?:${CREDENTIAL_WORD.slice(3, -1)}|storepass|keypass)`;
const passKey = (key) => !/pass$/i.test(key) || /(?:[_.-](?:pass|Pass|PASS)|[a-z0-9]Pass)$/.test(key);
// A path to a key or certificate file names where a secret is, not the secret: ./certs/client.key.
const keyFile = (value) => /^\\?["']?(?:\.{1,2}[\\/]|~[\\/]|[\\/]\w|[A-Za-z]:[\\/])[\w.\\/ -]{0,300}\.(?:pem|key|crt|cer|der|p8|p12|pfx|jks|keystore)\\?["']?$/i.test(value);
// The key may be bare or quoted (also JSON-escaped inside a string), followed by ":", "=", or "=>".
// The value may be quoted (escaped or not, even unterminated) or bare; a bare value runs to the
// next whitespace, quote, ";" or "&" (the next field of a connection string, a URL query, or a
// shell line), so the rest of a quoted JSON object stays readable.
//
// Every pattern here runs over every agent message, command, and tool argument on every scene, so each
// must take linear time on any text (see test/redaction-speed.test.mjs): every repeat is bounded, no
// two unbounded repeats can split the same run of characters, and a quoted value that may step over
// escaped quotes is bounded too, or it is anchored behind a key or flag, so a long line of escaped
// JSON is never scanned again from each of its quotes.
// A double-quoted value steps over a quote escaped with a backslash or, in PowerShell, a backtick.
const CREDENTIAL_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}?${PAIR_WORD})((?:\\?["'])?\s{0,40}(?:=>|[:=])\s{0,40})`
  + String.raw`(\\"(?:(?!\\")[^\r\n]){0,2000}(?:\\")?|"(?:[^"\\\r\n\x60]|[\\\x60][^\r\n]){0,2000}"?|'(?:[^'\\\r\n]|\\.){0,2000}'?`
  + String.raw`|(?:[^\s"'\\;&]|\\(?!")){1,2000})`, "gi");
const ALREADY_REMOVED = /\[(secret|private key)\b/;
const REMOVED = "[secret removed]";
// A value given as a quoted string, '...', or one bare word. Bounded: see CREDENTIAL_PAIR.
const QUOTED_VALUE = String.raw`"(?:[^"\\\r\n\x60]|[\\\x60][^\r\n]){0,400}"|'[^'\r\n]{0,400}'`;
const VALUE = String.raw`(${QUOTED_VALUE}|(?:[^\s"'\\;&|]|\\(?!")){1,400})`;
// Command-line style: --password hunter2, --api-key "abc", -Password 'abc', -Password ("abc").
const CREDENTIAL_FLAG = new RegExp(String.raw`(?<![A-Za-z0-9-])(--?[A-Za-z0-9_-]{0,40}?${FLAG_WORD})(\s{1,40}(?:\((?=\s{0,5}["'])\s{0,5})?)(?!-)${VALUE}`, "gi");
// A short password flag means a password only after the tools that use it so: sqlcmd/bcp/osql
// "-P secret", mysql "-psecret" (attached; "mysql -p db" prompts instead), docker/podman login
// "-p secret", and sshpass "-p secret". Elsewhere -p and -P are ports and flags (ssh -p 22, docker
// run -p 8080:80, rsync -P, pytest -p plugin) and stay. Likewise curl's -u user:password. The command
// and the flag must sit on one line, within 400 characters.
const ARG = String.raw`("(?:[^"\r\n\x60]|\x60[^\r\n]){0,400}"|'[^'\r\n]{0,400}'|[^\s"']{1,400})`;
// -P with the password attached is a password too (-PHunter2); -PacketSize is not, and neither is
// PowerShell's Invoke-Sqlcmd -Password (a named parameter, filtered as a flag below).
const SQL_PASSWORD_FLAG = new RegExp(String.raw`((?<![\w-])(?:sqlcmd|SQLCMD|Sqlcmd|osql|OSQL|bcp|BCP|isql)(?:\.exe)?\b[^\r\n;|&]{0,400}?\s-P)(?!acket)(\s{0,20})(?!-)${ARG}`, "g");
const MYSQL_PASSWORD_FLAG = new RegExp(String.raw`(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlsh|mariadb|mariadb-dump)(?:\.exe)?\b[^\r\n;|&]{0,400}?\s-p)()(?=[^\s-])${ARG}`, "g");
// sshpass's -p comes among its own options (-f file, -d fd, -e, -P prompt, -v); a later -p is ssh's port.
const LOGIN_PASSWORD_FLAG = new RegExp(String.raw`(\b(?:(?:docker|podman|nerdctl)(?:\.exe)?\s{1,20}login\b[^\r\n;|&]{0,400}?\s|sshpass(?:\s{1,20}-(?:[fdP]\s{0,20}[^\s-]\S{0,200}|e\S{0,60}|v)){0,6}\s{1,20})-p)(=|\s{0,20})(?!-)${ARG}`, "g");
/**
 * More tools whose short flag is the password, each only after its own command on the same line: the
 * same flag elsewhere stays (redis-cli -p 6379 and ldapsearch -p 389 are ports; their passwords are -a
 * and -w). `attached`: the password follows the flag directly (7z -pSecret; 7z -p alone prompts).
 * `stop`: what a value never starts with (another option, or on Windows a /switch or * for "prompt").
 */
const toolFlag = (command, flag, { attached = false, stop = "-", ignoreCase = false } = {}) => new RegExp(
  String.raw`((?<![\w.-])(?:${command})(?:\.exe|\.cmd)?\b[^\r\n;|&]{0,400}?\s${flag})`
  + (attached ? String.raw`()(?=[^\s-])` : String.raw`(\s{1,20})(?![${stop}])`) + ARG, ignoreCase ? "gi" : "g");
const TOOL_PASSWORD_FLAGS = [
  toolFlag(String.raw`az\s{1,20}login`, "-p"),
  toolFlag("psexec|psexec64", "-p"),
  toolFlag("mongosh|mongo|mongodump|mongorestore|mongoexport|mongoimport|mongostat|mongotop", "-p"),
  toolFlag("redis-cli", "(?:-a|--pass)"),
  toolFlag("ldapsearch|ldapmodify|ldapadd|ldapdelete|ldappasswd|ldapwhoami|ldapcompare|ldapmodrdn|ldapexop", "-w"),
  toolFlag("openssl", "-[kK]"),
  toolFlag("zip|unzip|zipcloak", "-P"),
  toolFlag("7z|7za|7zr", "-p", { attached: true }),
  toolFlag("cmdkey", "/pass:", { attached: true, ignoreCase: true }),
  toolFlag("schtasks", "/r?p", { stop: "-/", ignoreCase: true }),
];
// net use \\host\share <password> /user:name (a "*" asks for it instead), and smbclient -U user%password.
const NET_USE = new RegExp(String.raw`(\bnet(?:\.exe)?\s{1,20}use\s{1,20}(?:[A-Za-z]:\s{1,20})?(?:"\\\\[^"\r\n]{1,300}"|\\\\[^\s"]{1,300})\s{1,20})(?![/*-])${ARG}`, "gi");
const SMB_USER = new RegExp(String.raw`((?<![\w.-])(?:smbclient|rpcclient|smbcacls|smbget|smbmap|smbcquotas)(?:\.exe)?\b[^\r\n;|&]{0,400}?\s(?:-U|--user(?:=|\s{1,20}))\s{0,20}["']?[^\s%"']{1,200}%)([^\s"']{1,400})`, "g");
const CURL_USER = new RegExp(String.raw`(\bcurl(?:\.exe)?\b[^\r\n;|&]{0,400}?\s(?:-u\s{0,20}|--user[\s=]{1,20})["']?[^\s:"']{0,200}:)([^\s"']{1,400})`, "gi");
// openssl's password arguments: -passin pass:secret, -passout "pass:secret" (env: and file: name
// where the password is, and stay).
const OPENSSL_PASS = /(\s-(?:passin|passout|pass|password|passwd)\s{1,20})(?:"pass:([^"\r\n]{0,400})"|'pass:([^'\r\n]{0,400})'|pass:([^\s"']{1,400}))/gi;
// aws configure set aws_secret_access_key <key>: the key holds "/" and "+", which the long-run rule misses.
const AWS_CONFIGURE = new RegExp(String.raw`(\baws(?:\.exe)?\s{1,20}configure\s{1,20}set\s{1,20}(?:[\w-]{1,40}\.){0,3}(?:aws_secret_access_key|aws_session_token)\s{1,20})${ARG}`, "gi");
// npm's per-registry credentials: //registry.example.com/:_authToken npm_... (with a space or "=").
const NPM_AUTH = new RegExp(String.raw`(\/\/[^\s"'=]{1,300}?:_(?:authToken|auth|password)(?:\s{0,20}=\s{0,20}|\s{1,20}))${ARG}`, "g");
// PowerShell plaintext passwords: ConvertTo-SecureString "secret" -AsPlainText (first argument,
// -String, or a string piped in) and [NetworkCredential]::new("user", "secret") or New-Object.
// Its switches may come first: ConvertTo-SecureString -AsPlainText -Force "secret".
const SECURE_STRING = new RegExp(String.raw`(\bConvertTo-SecureString(?:\s{1,20}-(?:AsPlainText|Force)(?::\$?\w{1,10})?){0,3}\s{1,20}(?:-String(?::|\s{1,20}))?)${ARG}`, "gi");
const SECURE_STRING_NAMED = new RegExp(String.raw`(\bConvertTo-SecureString\b[^\r\n;|]{0,400}?\s-String(?::|\s{1,20}))${ARG}`, "gi");
// A string piped in may start at any quote, so only a quote no backslash or backtick escapes can open
// one (PowerShell escapes with a backtick; a JSON-escaped line has its own \" form): the scans from
// such quotes never overlap, so a line of thousands of escaped quotes is read once.
const SECURE_STRING_PIPED = new RegExp(String.raw`(\\"(?:(?!\\")[^\r\n]){0,200}\\"|(?<![\\\x60])(?:"(?:[^"\r\n\x60]|\x60[^\r\n]){0,200}"|'[^'\r\n]{0,200}'))`
  + String.raw`(\s{0,20}\|\s{0,20}ConvertTo-SecureString\b)`, "gi");
const NETWORK_CREDENTIAL = new RegExp(String.raw`(\bNetworkCredential\]?\s{0,20}(?:::new\s{0,20})?(?:\(\s{0,20}|\s{1,20}-ArgumentList\s{1,20}\(?\s{0,20})`
  + String.raw`(?:${QUOTED_VALUE}|[^\s,()"']{1,200})\s{0,20},\s{0,20})(${QUOTED_VALUE}|[^\s,()"']{1,200})`, "gi");
// A connection string's Password=...; or Pwd=...; runs to the next ";", spaces and all: after a ";"
// (Server=db;Password=a b c) or before one (Password=a b c;Server=db). Code such as
// "password = read(x);" or "password == null;" is not a connection string and is left to the rules below.
const CONNECTION_PASSWORD_AFTER = /(;\s{0,20}(?:password|pwd)\s{0,20}=\s{0,20})(?![\s"'=])([^;"'\r\n]{0,200}[^;"'\s\r\n])/gi;
const CONNECTION_PASSWORD_BEFORE = /(\b(?:password|pwd)=)(?![\s"'=])([^;"'\r\n]{0,200}[^;"'\s\r\n])(?=\s{0,20};)/gi;
// A shell or PowerShell variable named for a secret: $pw = "...", $dbPass='...', $env:API_TOKEN = ...,
// export API_TOKEN=..., set PASSWORD=..., DB_PASS=... npm run (upper-case names only, without a keyword).
const SECRET_VARIABLE = new RegExp(String.raw`((?:\$(?:[A-Za-z]{1,10}:)?|\b(?:export|set|setx|local|readonly|declare(?:\s{1,20}-[A-Za-z]{1,4})?)\s{1,20}"?|(?<=^|[\s;&|(])(?=[A-Z][A-Z0-9_]{0,60}\s{0,20}=))`
  + String.raw`([A-Za-z_][A-Za-z0-9_]{0,60})(\s{0,20}=\s{0,20}))(${QUOTED_VALUE}|[^\s;"'|&)]{1,400})`, "gm");
// The same, set without "=": setx API_TOKEN "...", [Environment]::SetEnvironmentVariable("API_TOKEN", "..."),
// and Python's os.environ["API_TOKEN"] = "...". Only names that say they hold a secret (see secretName).
const SETX_VARIABLE = new RegExp(String.raw`(\bsetx(?:\.exe)?\s{1,20}("?)([A-Za-z_][A-Za-z0-9_]{0,60})\2\s{1,20})(?![/-])${ARG}`, "gi");
const SET_ENVIRONMENT = new RegExp(String.raw`(\bSetEnvironmentVariable\s{0,20}\(\s{0,20}(["'])([A-Za-z_][A-Za-z0-9_]{0,60})\2\s{0,20},\s{0,20})(${QUOTED_VALUE})`, "gi");
const ENVIRON_ITEM = new RegExp(String.raw`(\benviron\s{0,20}\[\s{0,20}(["'])([A-Za-z_][A-Za-z0-9_]{0,60})\2\s{0,20}\]\s{0,20}=\s{0,20})(${QUOTED_VALUE})`, "g");
const SECRET_NAME_WORDS = new Set(["pw", "pwd", "pass", "passwd", "password", "passphrase", "passcode", "secret", "token", "apikey",
  "credential", "credentials", "cred", "creds"]);
const KEY_OWNERS = new Set(["api", "access", "secret", "private", "account", "client", "auth", "master", "storage", "signing", "encryption", "shared"]);
// Authorization headers keep their scheme and lose the credential after it: "Authorization: Bearer [secret removed]".
// Any scheme word does (Bot, OAuth, AWS, "Bearer:"): a first word shaped like a scheme (letters, "." and
// "-", or one of these) is kept; one that is not is the credential itself. A scheme whose credential is a
// list of parameters (OAuth k="v", k="v"; Digest; AWS4) loses the whole list.
const AUTH_SCHEMES = String.raw`sharedkeylite|sharedkey|sharedaccesssignature|aws4-hmac-sha256|bearer|basic|token|digest|negotiate|ntlm|hmac|signature|apikey|api-key|key|pat|dpop|sas`;
const AUTH_PARAMS = String.raw`(?:[\w.-]{1,40}=(?:\\?"[^"\\\r\n]{0,400}\\?"|[^\s,"'\\]{0,400}),?\s{0,5}){1,30}`;
const AUTH_HEADER = new RegExp(String.raw`(\b(?:proxy-)?authorization(?:\\?["'])?\s{0,20}[:=]\s{0,20}(?:\\?["']\s{0,20})?)([A-Za-z][\w.-]{0,30}:?)(\s{1,20})`
  + String.raw`(${AUTH_PARAMS}|[^\s"'\\]{1,2000})([^"'\\\r\n]{0,2000})`, "gi");
const AUTH_SCHEME = new RegExp(`^(?:${AUTH_SCHEMES})$`, "i");
const schemeWord = (word) => AUTH_SCHEME.test(word.replace(/:$/, "")) || /^[A-Za-z][A-Za-z.-]{0,30}:?$/.test(word);
const SEVERAL_PARTS = /^(?:aws4-hmac-sha256|aws|digest|signature|hmac|oauth)$/i;
// Webhook urls whose path is the credential.
const WEBHOOK_URL = /(\bhttps?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)\/|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/))[A-Za-z0-9_\/-]+/gi;
// A password in a url (scheme://user:password@host); the user name stays. The password runs to the
// last "@" before the host, so one holding "@" is still removed whole.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s\/:@"'<>]{1,200}:)([^\s\/"'<>]{1,300})@/gi;
// Prose: "the password is Hunter2Secret!". Only a value that does not read as a word is removed
// ("the password is incorrect" stays), and quoted values always are.
const SPOKEN_SECRET = new RegExp(String.raw`(\b(?:password|passphrase|passcode|pwd|secret|token|api key)\s{1,20}(?:is|was|=)\s{1,20}(?:now\s{1,20}|set to\s{1,20})?)`
  + String.raw`("[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|\x60[^\x60\r\n]{1,200}\x60|[^\s"'\x60]{4,200})`, "gi");
// Well-known token shapes: Stripe live/test keys and webhook secrets, GitLab tokens, npm tokens.
const KNOWN_TOKEN = /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,}|gl(?:pat|dt|rt|ptt|ft|cbt|soat|imt)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})/g;
// A SAS token's signature in a URL query (?sv=...&sig=...), whatever else surrounds it.
const SAS_SIGNATURE = /((?<![A-Za-z0-9_.-])sig=)([^&\s"'#]+)/gi;

/**
 * A bare value that names where a secret is rather than holding it: a variable ($pw, ${PW},
 * $env:PW, %PW%), a subexpression or array ((Get-Credential), @(...), @{...}, [..]), or a cmdlet
 * (Read-Host, Get-Secret). These stay, so "-Password $pw" reads as written.
 */
const notLiteral = (value) => /^(?:\$[A-Za-z_{(]|%[A-Za-z_][A-Za-z0-9_]*%$|[([]|@[({])/.test(value) || /^[A-Z][a-z]+-[A-Z][A-Za-z]+$/.test(value);
// "$PW" and "${PW}" in double quotes expand a variable in a shell and in PowerShell; '$PW' is literal.
const quotedReference = (value) => /^"(?:\$\{?[A-Za-z_][A-Za-z0-9_:]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)"$/.test(value);

/** The secret in a value removed, its quotes kept: "abc" -> "[secret removed]", abc -> [secret removed]. */
function removedValue(value) {
  if (ALREADY_REMOVED.test(value) || quotedReference(value)) return value;
  if (/^\\"/.test(value)) return `\\"${REMOVED}\\"`;
  if (/^["']/.test(value)) return `${value[0]}${REMOVED}${value.at(-1) === value[0] && value.length > 1 ? value[0] : ""}`;
  return notLiteral(value) ? value : REMOVED;
}

/** Whether a variable's name says it holds a secret: pw, dbPass, ADMIN_PASSWORD, API_KEY, githubToken. */
function secretName(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/_+/).filter(Boolean).map((word) => word.toLowerCase());
  const last = words.at(-1) || "";
  return SECRET_NAME_WORDS.has(last) || (last === "key" && KEY_OWNERS.has(words.at(-2) || ""));
}

/** Remove things that look like credentials from public text, keeping the words around them. */
export function redactSecrets(text) {
  let out = String(text ?? "")
    .replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, "[private key removed]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REMOVED)
    .replace(KNOWN_TOKEN, REMOVED)
    .replace(WEBHOOK_URL, `$1${REMOVED}`)
    .replace(SAS_SIGNATURE, `$1${REMOVED}`)
    .replace(URL_PASSWORD, (whole, lead, value) => (ALREADY_REMOVED.test(value) || notLiteral(value) ? whole : `${lead}${REMOVED}@`))
    .replace(AUTH_HEADER, (whole, lead, scheme, space, credential, rest) => {
      // A first word that is no scheme is the credential itself: "Authorization: <token> ...".
      if (!schemeWord(scheme)) return ALREADY_REMOVED.test(scheme) || notLiteral(scheme) ? whole : `${lead}${REMOVED}${space}${credential}${rest}`;
      if (ALREADY_REMOVED.test(credential) || notLiteral(credential)) return whole;
      // SharedKey account:signature keeps the account; schemes with several parts lose them all.
      const account = /^sharedkey/i.test(scheme) ? /^[^:]{1,100}:/.exec(credential)?.[0] || "" : "";
      const several = SEVERAL_PARTS.test(scheme.replace(/:$/, ""));
      return `${lead}${scheme}${space}${account}${REMOVED}${several ? "" : rest}`;
    })
    .replace(SQL_PASSWORD_FLAG, (whole, lead, space, value) => `${lead}${space}${removedValue(value)}`)
    .replace(MYSQL_PASSWORD_FLAG, (whole, lead, space, value) => `${lead}${removedValue(value)}`)
    .replace(LOGIN_PASSWORD_FLAG, (whole, lead, space, value) => `${lead}${space}${removedValue(value)}`);
  for (const pattern of TOOL_PASSWORD_FLAGS) out = out.replace(pattern, (whole, lead, space, value) => `${lead}${space}${removedValue(value)}`);
  return out
    .replace(NET_USE, (whole, lead, value) => `${lead}${removedValue(value)}`)
    .replace(SMB_USER, `$1${REMOVED}`)
    .replace(CURL_USER, `$1${REMOVED}`)
    .replace(OPENSSL_PASS, (whole, lead, double, single, bare) => (double != null ? `${lead}"pass:${REMOVED}"` : single != null ? `${lead}'pass:${REMOVED}'` : `${lead}pass:${REMOVED}`))
    .replace(AWS_CONFIGURE, (whole, lead, value) => `${lead}${removedValue(value)}`)
    .replace(NPM_AUTH, (whole, lead, value) => `${lead}${removedValue(value)}`)
    .replace(SECURE_STRING, (whole, lead, value) => (value.startsWith("-") ? whole : `${lead}${removedValue(value)}`))
    .replace(SECURE_STRING_NAMED, (whole, lead, value) => `${lead}${removedValue(value)}`)
    .replace(SECURE_STRING_PIPED, (whole, value, pipe) => `${removedValue(value)}${pipe}`)
    // A bare second argument is a variable in C# and PowerShell method calls, but a word after -ArgumentList.
    .replace(NETWORK_CREDENTIAL, (whole, lead, value) => (/^["']/.test(value) || /-ArgumentList/i.test(lead) ? `${lead}${removedValue(value)}` : whole))
    .replace(CONNECTION_PASSWORD_AFTER, (whole, lead, value) => (ALREADY_REMOVED.test(value) || notLiteral(value) ? whole : `${lead}${REMOVED}`))
    .replace(CONNECTION_PASSWORD_BEFORE, (whole, lead, value) => (ALREADY_REMOVED.test(value) || notLiteral(value) ? whole : `${lead}${REMOVED}`))
    .replace(SECRET_VARIABLE, (whole, lead, name, separator, value) => {
      if (!secretName(name)) return whole;
      // A counter or a flag is not a secret: $pass = 0, $secret = $true.
      if (!/^["']/.test(value) && (/^\d{1,3}$/.test(value) || /^(?:true|false|null|none|yes|no)$/i.test(value))) return whole;
      if (/^(["'])\1$/.test(value) || /^["']\$[A-Za-z_{]/.test(value)) return whole;
      return `${lead}${removedValue(value)}`;
    })
    .replace(SETX_VARIABLE, (whole, lead, quote, name, value) => (secretName(name) ? `${lead}${removedValue(value)}` : whole))
    .replace(SET_ENVIRONMENT, (whole, lead, quote, name, value) => (secretName(name) ? `${lead}${removedValue(value)}` : whole))
    .replace(ENVIRON_ITEM, (whole, lead, quote, name, value) => (secretName(name) ? `${lead}${removedValue(value)}` : whole))
    .replace(SPOKEN_SECRET, (whole, lead, value) => {
      const bare = value.replace(/[.,;:)]+$/, "");
      if (/^["'\x60]/.test(value)) return `${lead}${value[0]}${REMOVED}${value[0]}`;
      // An ordinary word, or a number too short to be a secret, is left alone.
      if (/^[A-Za-z]+$/.test(bare) || ALREADY_REMOVED.test(value) || bare.length < 4 || notLiteral(bare)) return whole;
      return `${lead}${REMOVED}${value.slice(bare.length)}`;
    })
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, REMOVED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REMOVED)
    // "Bearer abc..." outside a header; a plain word after it ("Basic authentication") is left alone.
    .replace(/\b(bearer|basic)(\s{1,20})([A-Za-z0-9._~+/=-]{12,})/gi, (whole, scheme, space, token) => (/^[A-Za-z]{12,15}$/.test(token) ? whole : `${scheme}${space}${REMOVED}`))
    .replace(CREDENTIAL_PAIR, (whole, key, separator, value, offset, all) => {
      // "Authorization: Bot [secret removed]" was already handled above: its scheme word stays.
      const scheme = /authorization$/i.test(key) && (AUTH_SCHEME.test(value) || /^\s{1,20}\[secret removed\]/.test(all.slice(offset + whole.length, offset + whole.length + 40)));
      // A comparison ("password == null") holds no value; "bypass: true" and "pass: 42" name no pass, though
      // a quoted "pass": "..." does; "client_key: ./certs/client.key" says where a key is.
      const pass = passKey(key) || (/^["']?pass$/i.test(key) && /^\\?["']/.test(value));
      if (ALREADY_REMOVED.test(value) || value.startsWith("=") || scheme || !pass || keyFile(value) || notLiteral(value)) return whole;
      const quote = /^\\"/.test(value) ? "\\\"" : /^["']/.test(value) ? value[0] : "";
      return `${key}${separator}${quote}${REMOVED}${quote}`;
    })
    .replace(CREDENTIAL_FLAG, (whole, flag, space, value) => `${flag}${space}${removedValue(value)}`)
    // A long run of letters and digits is a token; a full commit id or sha256 is an id. Each run is read
    // once, whole, and judged here, rather than looked ahead into again from every "-" inside it.
    .replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g,
      (token) => (/\d/.test(token) && /[A-Za-z]/.test(token) && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(token) ? REMOVED : token));
}

function fileTarget(tool, input) {
  if (!FILE_TOOLS[tool] || !input || typeof input !== "object") return "";
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof raw !== "string" || !raw.trim()) return "";
  const base = raw.split(/[\\/]/).filter(Boolean).at(-1) || "";
  if (!base || /[\u0000-\u001f]/.test(base)) return "";
  if (PRIVATE_NAME.test(base)) return "a private file";
  return clip(base, 80);
}

// Control characters other than tabs and line breaks never reach a record.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Text for a record: filtered for credentials, then clipped. Cut to twice the limit first, so a huge
 * command or prompt costs nothing to filter, and a credential straddling the cut is still whole when
 * the filter sees it.
 */
function recordText(value, max) {
  if (typeof value !== "string" || !value.trim()) return "";
  return clip(redactSecrets(value.slice(0, max * 2)).replace(/\r\n?/g, "\n").replace(CONTROL, ""), max);
}

/** An MCP tool name split into its server and tool: mcp__billing-api__create_invoice. */
function mcpName(tool) {
  const parts = String(tool || "").split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? { server: parts[1], tool: parts.slice(2).join("__") } : null;
}

/**
 * What a tool call works on, in full, before it is filtered: the command, the full file path, the
 * search pattern (and where), the url or query, the subagent's description, the skill, or the MCP
 * server and tool. The first line is what a one-line title shows.
 */
function toolSubject(tool, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const text = (value) => (typeof value === "string" ? value : "");
  const name = String(tool || "");
  if (SHELL_TOOLS.has(name)) return text(input.command);
  if (FILE_TOOLS[name]) return text(input.file_path ?? input.notebook_path ?? input.path);
  if (name === "Grep" || name === "Glob") return [text(input.pattern), text(input.path) && `in ${text(input.path)}`].filter(Boolean).join("\n");
  if (name === "WebFetch") return text(input.url);
  if (name === "WebSearch") return text(input.query);
  if (name === "Agent" || name === "Task") return text(input.description);
  if (name === "Skill") return text(input.skill ?? input.command ?? input.name);
  if (name === "AskUserQuestion") return text(input.questions?.[0]?.question);
  if (name === "TaskCreate") return text(input.subject);
  if (name === "TaskUpdate") return [input.taskId != null ? `#${input.taskId}` : "", text(input.status)].filter(Boolean).join(" ");
  const mcp = mcpName(name);
  return mcp ? `${mcp.server} · ${mcp.tool}` : "";
}

/**
 * A short signature of one call's input, so a permission request, its tool call, and the call's result
 * can be matched when Claude Code leaves out the tool_use_id. Parallel calls of one tool differ in input.
 */
const callSig = (tool, input) => createHash("sha256").update(`${tool}\n${JSON.stringify(input ?? null).slice(0, 65_536)}`).digest("hex").slice(0, 12);

/** AskUserQuestion's questions and option labels: [{ q, options }]. */
function questionsIn(list) {
  return (Array.isArray(list) ? list.slice(0, 4) : []).map((item) => ({
    q: recordText(item?.q ?? item?.question ?? item?.header, 300),
    options: (Array.isArray(item?.options) ? item.options.slice(0, 6) : [])
      .map((option) => recordText(typeof option === "string" ? option : option?.label, 80)).filter(Boolean),
  })).filter((item) => item.q);
}

/** A todo list as Claude Code shows it: the active item by its "-ing" form, the rest by their content. */
function todosIn(list) {
  return (Array.isArray(list) ? list.slice(0, CLAUDE_LIMITS.todos) : []).map((item) => {
    const s = TODO_STATES.has(item?.s ?? item?.status) ? item.s ?? item.status : "pending";
    const text = item?.t ?? (s === "in_progress" ? item?.activeForm || item?.content : item?.content || item?.activeForm);
    return { t: recordText(text, CLAUDE_LIMITS.todoChars), s };
  }).filter((item) => item.t);
}

const taskId = (value) => {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : "";
};

/** The id a TaskCreate result gives the new task: { task: { id } }, { id }, or "Task #3 created". */
function createdTaskId(response) {
  if (response && typeof response === "object") return taskId(response.task?.id ?? response.id ?? response.taskId);
  return taskId(/#([A-Za-z0-9_-]{1,40})/.exec(String(response ?? "").slice(0, 400))?.[1]);
}

/** Just enough of TaskCreate and TaskUpdate to follow the plan's progress: subject, id, status. */
function taskIn(event, tool, input, response) {
  if (tool === "TaskCreate" && event === "PreToolUse") {
    const subject = recordText(input?.subject, CLAUDE_LIMITS.todoChars);
    return subject ? { subject } : null;
  }
  if (tool === "TaskCreate" && event === "PostToolUse") {
    const id = createdTaskId(response);
    return id ? { id } : null;
  }
  if (tool !== "TaskUpdate" || event !== "PreToolUse" || !taskId(input?.taskId)) return null;
  const task = { id: taskId(input.taskId) };
  if (TASK_STATES.has(input.status)) task.status = input.status;
  const subject = recordText(input.subject, CLAUDE_LIMITS.todoChars);
  if (subject) task.subject = subject;
  return task;
}

function cleanTask(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const task = {};
  if (taskId(raw.id)) task.id = taskId(raw.id);
  if (TASK_STATES.has(raw.status)) task.status = raw.status;
  const subject = recordText(raw.subject, CLAUDE_LIMITS.todoChars);
  if (subject) task.subject = subject;
  return Object.keys(task).length ? task : null;
}

// The Orca identity a hook may record: which terminal, pane, worktree, and workspace the session runs
// in. Orca puts these in every terminal it opens (the same names its own CLI reads), and the hook runs
// in Claude Code's terminal, so it sees them. Each value is an id, never text anyone typed.
const ORCA_FIELDS = Object.freeze({ terminal: "ORCA_TERMINAL_HANDLE", pane: "ORCA_PANE_KEY", worktree: "ORCA_WORKTREE_ID", workspace: "ORCA_WORKSPACE_ID" });
const ORCA_SHAPES = Object.freeze({
  terminal: /^term_[A-Za-z0-9_-]{1,80}$/, // As Orca issues handles; never a flag or a path.
  pane: /^[A-Za-z0-9_.-]{1,80}:[A-Za-z0-9-]{1,64}$/, // "<tab id>:<leaf uuid>"
  // "<repo id>::<folder>" or "worktree:…" / "folder:…": printable, one line.
  worktree: /^[^\u0000-\u001f\u007f]{1,1024}$/,
  workspace: /^[^\u0000-\u001f\u007f]{1,1024}$/,
});
const ORCA_ID_CHARS = 120;

/**
 * One Orca id, shape-checked and at most 120 characters. A longer worktree or workspace id (it holds a
 * folder path) keeps its start and gains a hash of the whole, so two ids stay equal exactly when they
 * were. "" for anything else.
 */
function orcaId(field, value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || !ORCA_SHAPES[field]?.test(text)) return "";
  if (text.length <= ORCA_ID_CHARS) return text;
  if (field === "terminal" || field === "pane") return "";
  return `${text.slice(0, ORCA_ID_CHARS - 18)}#${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/**
 * Which Orca terminal, pane, worktree, and workspace a Claude Code session runs in, from the hook's own
 * environment (or a record read back from disk): { terminal?, pane?, worktree?, workspace? }, or null
 * outside Orca. This names the session's terminal exactly, so a task can be grouped even when Orca's
 * command line cannot be reached.
 */
export function orcaIdentity(source, { fromEnv = false } = {}) {
  if (!source || typeof source !== "object") return null;
  const identity = {};
  for (const [field, name] of Object.entries(ORCA_FIELDS)) {
    const value = orcaId(field, fromEnv ? source[name] : source[field]);
    if (value) identity[field] = value;
  }
  return Object.keys(identity).length ? identity : null;
}

// The records that carry the Orca identity: every event but a tool result, so a session that was already
// running in an Orca terminal when the hook was installed is placed in its task at its next step.
const ORCA_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Notification",
  "SubagentStart", "SubagentStop", "Stop", "StopFailure", "SessionEnd"]);

/** A transcript's own path, so the detail view can read it later: absolute, .jsonl, nothing odd in it. */
function transcriptPath(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) return "";
  return /\.jsonl$/i.test(value) && (posix.isAbsolute(value) || win32.isAbsolute(value)) ? value : "";
}

/**
 * Validate one record, from the hook or from disk, keeping only known fields. Text is filtered and
 * clipped again here, so a record read back from disk is held to the same rules as a new one.
 * Returns null for anything that is not a well-formed Goblin Horde Claude record.
 */
export function cleanRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) return null;
  if (typeof raw.id !== "string" || !/^[a-f0-9]{8,32}$/.test(raw.id)) return null;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at <= 0) return null;
  if (!EVENTS.has(raw.event) || !safeId(raw.session)) return null;
  const record = { v: 1, id: raw.id, at: raw.at, event: raw.event, session: raw.session };
  if (safeId(raw.agent)) record.agent = raw.agent;
  if (safeLabel(raw.agentType)) record.agentType = safeLabel(raw.agentType);
  if (typeof raw.cwd === "string" && raw.cwd.trim() && !/[\u0000-\u001f]/.test(raw.cwd)) record.cwd = clip(raw.cwd, 300);
  if (typeof raw.tool === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(raw.tool)) record.tool = raw.tool;
  if (safeId(raw.toolUse)) record.toolUse = raw.toolUse;
  if (typeof raw.target === "string" && raw.target && !/[\\/\u0000-\u001f]/.test(raw.target)) record.target = clip(raw.target, 80);
  // Each kind of content belongs to the events that carry it, and nowhere else.
  const call = raw.event === "PreToolUse" || raw.event === "PermissionRequest";
  if (TOOL_EVENTS.has(raw.event) && typeof raw.sig === "string" && /^[a-f0-9]{12}$/.test(raw.sig)) record.sig = raw.sig;
  const detail = call ? recordText(raw.detail, CLAUDE_LIMITS.detailChars) : "";
  if (detail) record.detail = detail;
  if (call && safeLabel(raw.agentKind, 60)) record.agentKind = safeLabel(raw.agentKind, 60);
  // A subagent or shell command started in the background: its result comes back at once, when it has only started.
  if (call && raw.background === true && BACKGROUND_TOOLS.has(record.tool)) record.background = true;
  const asks = call ? questionsIn(raw.asks) : [];
  if (asks.length) record.asks = asks;
  // An empty list is kept: a TodoWrite that clears the list is news too.
  if (raw.event === "PreToolUse" && Array.isArray(raw.todos)) record.todos = todosIn(raw.todos);
  const task = TOOL_EVENTS.has(raw.event) ? cleanTask(raw.task) : null;
  if (task) record.task = task;
  if (NEEDS_NOTICES.has(raw.notice) || CLEAR_NOTICES.has(raw.notice) || raw.notice === IDLE_NOTICE) record.notice = raw.notice;
  if (START_SOURCES.has(raw.start)) record.start = raw.start;
  if (END_REASONS.has(raw.reason)) record.reason = raw.reason;
  if (ERROR_TYPES.has(raw.errorType)) record.errorType = raw.errorType;
  const prompt = raw.event === "UserPromptSubmit" ? recordText(raw.prompt, CLAUDE_LIMITS.promptChars) : "";
  if (prompt) record.prompt = prompt;
  if (["SessionStart", "UserPromptSubmit", "Stop"].includes(raw.event) && transcriptPath(raw.transcript)) record.transcript = raw.transcript;
  if ((raw.event === "SubagentStart" || raw.event === "SubagentStop") && transcriptPath(raw.agentTranscript)) record.agentTranscript = raw.agentTranscript;
  // A needs-you notification's own words, or a final reply's excerpt.
  const messageMax = raw.event === "Notification" ? (NEEDS_NOTICES.has(raw.notice) ? CLAUDE_LIMITS.noticeChars : 0) : CLAUDE_LIMITS.excerptChars;
  const message = messageMax ? recordText(raw.message, messageMax) : "";
  if (message) record.message = message;
  // A subagent's last message goes to its parent agent, never to the person, so it is never a question.
  if (raw.event !== "SubagentStop" && !record.agent) {
    const question = recordText(raw.question, CLAUDE_LIMITS.questionChars);
    if (question) record.question = question;
  }
  if (cleanModelId(raw.model)) record.model = cleanModelId(raw.model);
  const orca = ORCA_EVENTS.has(raw.event) ? orcaIdentity(raw.orca) : null;
  if (orca) record.orca = orca;
  const orcaTo = raw.event === "PreToolUse" && SHELL_TOOLS.has(record.tool) ? orcaTargets(raw.orcaTo) : [];
  if (orcaTo.length) record.orcaTo = orcaTo;
  return record;
}

const TARGET_HANDLE = new RegExp(`^${ORCA_HANDLE_TEXT}$`);
const TARGET_VERB = /^(?:orchestration|terminal) [a-z][a-z-]{0,30}$/;

/**
 * The Orca terminals a shell command directs ([{ terminal, verb, flag }], at most 8), checked again when
 * read back. The command itself is kept filtered, and the filter blanks long ids such as terminal
 * handles, so these are taken from the command before it (see commandTerminals).
 */
function orcaTargets(list) {
  return (Array.isArray(list) ? list : []).filter((item) => TARGET_HANDLE.test(String(item?.terminal)) && TARGET_VERB.test(String(item?.verb))
    && ["terminal", "to", "from"].includes(item?.flag)).slice(0, 8).map(({ terminal, verb, flag }) => ({ terminal, verb, flag }));
}

/**
 * Keep a record within one log line. Every field is already clipped, so only a record with many long
 * fields (a full todo list of long items) needs this; the least needed fields go first.
 */
function fitRecord(record, limit = CLAUDE_LIMITS.lineChars) {
  if (!record) return null;
  const fits = () => JSON.stringify(record).length + 1 <= limit;
  while (!fits() && record.todos?.length > 1) record.todos = record.todos.slice(0, Math.ceil(record.todos.length / 2));
  for (const field of ["asks", "todos", "prompt", "message", "question", "detail", "task"]) if (!fits()) delete record[field];
  return fits() ? record : null;
}

/**
 * Turn one hook payload into a bounded, filtered record, or null when nothing should be kept. `env` is
 * the hook's own environment: inside an Orca terminal, every record but a tool result keeps
 * which terminal, pane, worktree, and workspace the session runs in (see orcaIdentity).
 */
export function normalizeHookEvent(input, { now = Date.now(), id = randomBytes(8).toString("hex"), env = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = input.hook_event_name;
  if (!EVENTS.has(event) || !safeId(input.session_id)) return null;
  const raw = { v: 1, id, at: now, event, session: input.session_id, agent: input.agent_id, agentType: input.agent_type, cwd: input.cwd };
  if (env && ORCA_EVENTS.has(event)) raw.orca = orcaIdentity(env, { fromEnv: true });
  // SessionStart names the model; newer Claude Code versions send it as { id, display_name }.
  const model = typeof input.model === "string" ? input.model : input.model?.id;
  if (cleanModelId(model)) raw.model = model;
  if (TOOL_EVENTS.has(event)) {
    const tool = input.tool_name;
    const toolInput = input.tool_input;
    raw.tool = tool;
    raw.toolUse = input.tool_use_id;
    const target = fileTarget(tool, toolInput);
    if (target) raw.target = target;
    if (toolInput && typeof toolInput === "object") raw.sig = callSig(tool, toolInput);
    if (event === "PreToolUse" || event === "PermissionRequest") {
      raw.detail = toolSubject(tool, toolInput);
      // Which Orca terminals the command directs, read before the filter blanks their handles.
      if (event === "PreToolUse" && SHELL_TOOLS.has(tool) && typeof toolInput?.command === "string") raw.orcaTo = commandTerminals(toolInput.command);
      if ((tool === "Agent" || tool === "Task") && typeof toolInput?.subagent_type === "string") raw.agentKind = toolInput.subagent_type;
      if (toolInput?.run_in_background === true) raw.background = true;
      if (tool === "AskUserQuestion") raw.asks = toolInput?.questions;
      if (tool === "TodoWrite" && event === "PreToolUse" && Array.isArray(toolInput?.todos)) raw.todos = toolInput.todos;
    }
    raw.task = taskIn(event, tool, toolInput, input.tool_response);
  }
  if (event === "Notification") {
    if (!NEEDS_NOTICES.has(input.notification_type) && !CLEAR_NOTICES.has(input.notification_type)
      && input.notification_type !== IDLE_NOTICE) return null;
    raw.notice = input.notification_type;
    // What Claude Code tells the person ("Claude needs your permission to use Bash"): the ask's words when
    // no request was captured. Filtered and clipped in cleanRecord; the title is not kept.
    if (NEEDS_NOTICES.has(raw.notice) && typeof input.message === "string") raw.message = input.message.slice(0, CLAUDE_LIMITS.noticeChars * 2);
  }
  if (event === "SessionStart") raw.start = input.source;
  if (event === "SessionEnd") raw.reason = input.reason;
  if (event === "UserPromptSubmit") raw.prompt = input.prompt;
  // Where the transcripts are, for the detail view; nothing in them is read here but the model id.
  if (event === "SessionStart" || event === "UserPromptSubmit" || event === "Stop") raw.transcript = input.transcript_path;
  if (event === "SubagentStart" || event === "SubagentStop") raw.agentTranscript = input.agent_transcript_path;
  if (event === "StopFailure") {
    const reason = typeof input.error === "string" ? input.error : input.error_type;
    raw.errorType = ERROR_TYPES.has(reason) ? reason : "unknown";
  }
  if ((event === "Stop" || event === "SubagentStop") && typeof input.last_assistant_message === "string") {
    // Only the opening excerpt and the closing question are kept, so only those are filtered; twice the
    // excerpt length keeps a credential that straddles the cut whole until it is removed.
    const full = input.last_assistant_message;
    raw.message = redactSecrets(full.slice(0, CLAUDE_LIMITS.excerptChars * 2));
    // Only the session's own reply can ask the person something; a subagent answers its parent.
    if (event === "Stop") raw.question = closingQuestion(redactSecrets(full.slice(-4000)), CLAUDE_LIMITS.questionChars);
  }
  return fitRecord(cleanRecord(raw));
}

// Events after which the transcript's newest assistant turn names the model in use.
const MODEL_EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop", "SubagentStop", "StopFailure"]);
// Lines that may carry the assistant's model; each is then parsed and checked properly.
const MODEL_HINT = '"model":"';

/**
 * The model the session (or subagent) last answered with, read from the newest end of its
 * transcript. Only the model id is taken; nothing else in the transcript is kept or parsed.
 * A subagent's own transcript sits beside the session's: <session>/subagents/agent-<id>.jsonl.
 */
export function transcriptModel(input, { maxBytes = 64 * 1024, readTail = readFileTail } = {}) {
  if (!input || !MODEL_EVENTS.has(input.hook_event_name)) return "";
  const main = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const agent = safeId(input.agent_id);
  let file = main;
  if (agent) {
    file = typeof input.agent_transcript_path === "string" && input.agent_transcript_path ? input.agent_transcript_path : "";
    if (!file && main) {
      const path = /\\/.test(main) && !main.includes("/") ? win32 : posix;
      file = path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents", `agent-${agent}.jsonl`);
    }
  }
  if (!file || !/\.jsonl$/i.test(file)) return "";
  let text = "";
  try { text = readTail(file, maxBytes); } catch { return ""; }
  let found = "";
  for (const line of text.split("\n")) {
    if (!line.includes(MODEL_HINT)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    // Tool calls and their results can carry a "model" of their own (an Agent's input, a tool's output).
    const model = record?.type === "assistant" ? record.message?.model : "";
    if (cleanModelId(model)) found = model;
  }
  return found;
}

/** Append one record to the app-owned log, rolling it over when it grows too large. */
export function appendClaudeRecord(record, { dir = claudeActivityDir(), rotateBytes = CLAUDE_LIMITS.rotateBytes } = {}) {
  const clean = cleanRecord(record);
  if (!clean) return false;
  const line = `${JSON.stringify(clean)}\n`;
  if (line.length > CLAUDE_LIMITS.lineChars) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "activity.jsonl");
  try {
    const size = statSync(file).size;
    if (size >= rotateBytes) {
      try { renameSync(file, join(dir, "activity.1.jsonl")); }
      // A reader may hold the file for a moment; past four times the limit, start over rather than grow.
      catch { if (size >= rotateBytes * 4) truncateSync(file, 0); }
    }
  } catch { /* No log yet. */ }
  appendFileSync(file, line, { mode: 0o600 });
  return true;
}

const emptyCounts = () => ({ updates: 0, commands: 0, research: 0, tools: 0 });

/** A public activity bubble for one tool step, in the same words the Codex feed uses. */
export function toolActivity(tool, target = "") {
  const name = String(tool || "tool");
  if (FILE_TOOLS[name] === "read") return { kind: "tool", title: target ? `Read ${target}` : "Read a local file", description: "Opened a local file to inspect its contents." };
  if (FILE_TOOLS[name] === "edit") return { kind: "file", title: target ? `Changed ${target}` : "Changed a file", description: target || "a file" };
  if (name === "Grep") return { kind: "tool", title: "Searched local files", description: "Looked for matching text in the project." };
  if (name === "Glob" || name === "LS") return { kind: "tool", title: "Looked for matching files", description: "Listed files in the project." };
  if (name === "Bash" || name === "PowerShell" || name === "BashOutput" || name === "KillShell") return { kind: "command", title: "Ran a local command", description: "Ran a command in the local workspace." };
  if (name === "WebSearch") return { kind: "research", title: "Searched the web", description: "Looked up information online." };
  if (name === "WebFetch") return { kind: "research", title: "Opened a source", description: "Read a web page." };
  if (name === "Task" || name === "Agent") return { kind: "tool", title: "Started a helper agent", description: "Handed part of the work to a subagent." };
  if (name === "TodoWrite") return { kind: "tool", title: "Updated the task list", description: "Updated its working plan." };
  if (name.startsWith("mcp__")) {
    const server = name.split("__")[1] || "connected app";
    return { kind: "tool", title: `Used ${clip(server.replace(/[_-]+/g, " "), 40)}`, description: "Used a connected tool." };
  }
  return { kind: "tool", title: `Used ${clip(name, 40)}`, description: `Used ${clip(name, 40)}.` };
}

function projectName(cwd) {
  return String(cwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

// The words of what a person types to keep a session going ("yes, please continue", "go ahead"); a
// prompt made only of these says nothing about what the session is for.
const NUDGE_WORDS = new Set(["y", "yes", "n", "no", "ok", "okay", "k", "sure", "yep", "yeah", "alright", "right", "go", "on", "ahead",
  "continue", "proceed", "do", "it", "that", "please", "keep", "going", "carry", "next", "retry", "try", "again", "thanks", "thank",
  "you", "thx", "done", "stop", "wait", "sounds", "looks", "good", "great", "fine", "lgtm", "and"]);
const isNudge = (text) => {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter(Boolean);
  return words.length <= 6 && words.every((word) => NUDGE_WORDS.has(word));
};
// A reply to the agent's own question ("No, only delete dist/old", "Option 2", "looks good, commit it",
// "What about the second one?") answers it; it says nothing about what the session is for.
const FOLLOW_UP = /^(?:no|nope|nah|yes|yeah|yep|ok|okay|sure|lgtm|perfect|great|thanks|thank you|sounds good|looks good|actually|instead|option\s*\w{1,3}|what about|how about|the (?:first|second|third|fourth|last|other) one)\b/i;

/**
 * A Claude Code session's title from one recorded prompt: its first line in plain words, at most `max`
 * characters, cut at a word. Claude Code names nothing, so without this every goblin read "Claude ·
 * <folder> · <hash>". Returns "" for a slash command, a nudge ("yes", "continue"), a reply to the agent's
 * question ("Option 2", "What about the second one?"), or nothing readable, so the caller keeps looking
 * for a prompt that says what the session is for. The prompt was already filtered for credentials when recorded.
 */
export function promptTitle(prompt, max = 60) {
  const line = String(prompt ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  if (!line || line.startsWith("/") || /^<[a-z][\w-]*>/i.test(line)) return "";
  const text = plainTitle(line);
  if (text.length < 4 || !/[A-Za-z]/.test(text) || isNudge(text) || FOLLOW_UP.test(text)) return "";
  return clipTitle(text, max);
}

/** One line of a title in plain words: markdown marks, quotes, and trailing punctuation removed. */
function plainTitle(line) {
  return String(line).replace(CONTROL, " ").replace(/^(?:#{1,6}\s+|>\s*|[-*•+]\s+|\d{1,2}[.)]\s+)/, "").replace(/\*\*|__|`/g, "")
    .replace(/\[secret removed\]/g, "…").replace(/\s+/g, " ").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/[\s.,;:!]+$/, "").trim();
}

/** A title of at most `max` characters, cut at a word. */
function clipTitle(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * A session title a transcript gives (a name the person set with /rename, or the title Claude Code wrote
 * for the session): its first line, credentials blanked, in plain words, at most `max` characters cut
 * at a word. "" when nothing readable is left.
 */
export function namedTitle(value, max = 60) {
  if (typeof value !== "string") return "";
  const line = value.slice(0, 2000).split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  const text = plainTitle(redactSecrets(line));
  return text.length >= 2 && /[\p{L}\p{N}]/u.test(text) ? clipTitle(text, max) : "";
}

/**
 * The name a Claude Code session goes by, in this order: a name the person gave it (`named.custom`, the
 * transcript's custom-title or agent-name), Claude Code's own title for it (`named.titled`, ai-title or
 * an older version's summary), the first prompt that says what it is for (`named.first`, from the head of
 * its transcript, else `hook`, the first such prompt the hook recorded; see promptTitle), and only then
 * the newest prompt in view (`named.last`). A follow-up never renames a session. `named` may be null or
 * an older shape with only `derived`. "" when there is no name. Pure.
 */
export function sessionTitle({ hook = "" } = {}, named = null) {
  return named?.custom || named?.titled || named?.first || hook || named?.last || named?.derived || "";
}

/**
 * The task each subagent was started with, from its session's Task (or Agent) calls: a SubagentStart
 * takes the oldest call not yet taken whose subagent type matches. Claude Code starts subagents in the
 * order it calls them, so "Explore" goblins read "Explore: Find invoice fixtures" instead of all
 * reading "Explore subagent".
 */
function noteSpawn(session, record) {
  if (!record.agent && record.event === "PreToolUse" && (record.tool === "Task" || record.tool === "Agent")) {
    session.spawns.push({ kind: String(record.agentKind || "").toLowerCase(), task: firstLine(record.detail, 60), taken: false,
      background: record.background === true });
    if (session.spawns.length > 50) session.spawns.shift();
  }
}

function claimSpawn(session, agent, agentType) {
  const type = String(agentType || "").toLowerCase();
  const spawn = session.spawns.find((item) => !item.taken && item.kind && item.kind === type)
    || session.spawns.find((item) => !item.taken && (!item.kind || !type));
  if (!spawn) return;
  spawn.taken = true;
  if (spawn.task) session.tasks.set(agent, spawn.task);
  // Started in the background, it works on after the session's turn ends and Claude Code is back at its prompt.
  if (spawn.background) session.background.add(agent);
}

/** A subagent goblin named for its task ("Explore: Find invoice fixtures"), when its task is known. */
function namedForTask(actor, task) {
  if (!task) return actor;
  const type = String(actor.agentType || "helper");
  const label = clip(`${type[0].toUpperCase()}${type.slice(1)}: ${task}`, 70);
  return { ...actor, name: label, nickname: label };
}

/** Party and goblin ids are fixed by the session and subagent ids, so they survive restarts and log roll-over. */
export const claudePartyId = (session) => `claude:${session}`;
export const claudeMainId = (session) => `claude-agent:${session}`;
export const claudeChildId = (session, agent) => `claude-agent:${session}:${agent}`;

function newActor(session, agent, record) {
  return {
    session, agent, cwd: record.cwd || "", agentType: record.agentType || "", startedAt: record.at, updatedAt: record.at,
    turns: [], openTurn: null, activities: [], tools: new Map(), calls: new Map(), finished: new Map(), asks: new Map(),
    ended: false, order: 0, plan: "", todos: [], tasks: new Map(), transcript: "", agentTranscript: "",
    lastDone: null, lastEvent: "",
  };
}

/** One tool call as the asks and `now` need it. */
const callOf = (record) => ({ toolUse: record.toolUse || "", tool: record.tool || "", target: record.target || "", sig: record.sig || "",
  detail: record.detail || "", agentKind: record.agentKind || "", asks: record.asks || null, at: record.at, background: record.background === true });

/**
 * Whether two records are the same tool call: by tool_use_id when both have one, else by the input's
 * signature, else (records from before signatures) by tool and file. Claude Code runs tools in
 * parallel, so "some later call finished" is never enough.
 */
function sameCall(a, b) {
  if (a.toolUse && b.toolUse) return a.toolUse === b.toolUse;
  if (a.sig && b.sig) return a.sig === b.sig && a.tool === b.tool;
  return Boolean(a.tool) && a.tool === b.tool && a.target === b.target;
}

/** The open call a record belongs to, by id or signature, oldest first; its key in `calls`, or "". */
function openCallKey(actor, record) {
  if (record.toolUse && actor.calls.has(record.toolUse)) return record.toolUse;
  const call = callOf(record);
  for (const [key, open] of actor.calls) if (sameCall(open, call)) return key;
  return "";
}

/**
 * Open questions to the person.
 *
 * A PermissionRequest, or an AskUserQuestion call, waits on its own tool call: its PostToolUse (or
 * PostToolUseFailure) answers it and no other call's does. A request sent without a tool_use_id takes
 * the id of the open call with the same input, so the right result answers it. A permission notice with
 * no request captured (hooks from an older install) waits on every call open when it arrived, or, with
 * none open, on the next sign of progress. The end of the turn or the session answers everything.
 *
 * Approving a permission sends no hook: the next one is the tool's own result, perhaps minutes later.
 * So a permission request starts unconfirmed and asks only for `unconfirmedMs`. Claude Code's own
 * notice (permission_prompt, about six seconds after a dialog opened and is still open) confirms it and
 * every other request still queued behind it (see confirmAsks); a confirmed one asks until its result,
 * the end of the turn, or a newer call or request from the same agent after the notice (the agent moved
 * on: it was approved and runs, or denied, which has no result).
 */
function addCallAsk(actor, record, kind) {
  const call = callOf(record);
  if (call.toolUse && actor.finished.has(call.toolUse)) return; // Its result is already in: answered.
  if (!call.toolUse) {
    const claimed = new Set([...actor.asks.values()].map((ask) => ask.toolUse).filter(Boolean));
    const open = [...actor.calls.values()].reverse().find((item) => item.toolUse && !claimed.has(item.toolUse) && sameCall(item, call));
    if (open) call.toolUse = open.toolUse;
    // Hooks run side by side, so a quick result can be stamped a moment before its own request.
    else if (call.sig && Math.abs((actor.finished.get(`sig:${call.sig}`) ?? -Infinity) - record.at) < 2000) return;
  }
  for (const ask of actor.asks.values()) {
    // The same call asking twice (its AskUserQuestion call, then its permission request) is one ask.
    if (ask.kind !== "notice" && sameCall(ask, call)) {
      ask.toolUse ||= call.toolUse;
      ask.asks ||= call.asks;
      ask.detail ||= call.detail;
      return;
    }
  }
  actor.asks.set(`call:${record.id}`, { ...call, kind });
}

/** The tool a notice names: "Claude needs your permission to use Bash" -> "Bash"; "" when it names none. */
const noticeTool = (message) => /\bpermission to use ([A-Za-z0-9_.:-]{1,80})/.exec(String(message || ""))?.[1] || "";

/**
 * A notice that a dialog is still open confirms the permission requests still waiting among `actors`
 * (a session's goblins, or one goblin). Claude Code shows one dialog at a time, oldest first, so every
 * request made before the notice and not yet answered is waiting: the oldest on screen, the rest queued
 * behind it. When the notice names the tool on screen, requests older than the oldest one for that tool
 * were answered before it came up (approving sends nothing), and only they are left out. A confirmed
 * request asks until its result, the end of the turn, or a newer call from its agent (see dropAnswered).
 * Returns the [actor, ask] pairs it confirmed.
 */
function confirmAsks(actors, record) {
  const waiting = [];
  for (const actor of actors) {
    for (const ask of actor.asks.values()) if (ask.kind === "permission" && !ask.confirmedAt && ask.at <= record.at) waiting.push([actor, ask]);
  }
  const tool = noticeTool(record.message);
  const shown = tool ? waiting.filter(([, ask]) => ask.tool === tool).sort((a, b) => a[1].at - b[1].at)[0] : null;
  const confirmed = shown ? waiting.filter(([, ask]) => ask.at >= shown[1].at) : waiting;
  for (const [, ask] of confirmed) ask.confirmedAt = record.at;
  return confirmed;
}

function addNotice(actor, record) {
  if (CONFIRM_NOTICES.has(record.notice) && confirmAsks([actor], record).length) return;
  // A question, or a request already confirmed, says what is asked; the notice is that same prompt.
  if ([...actor.asks.values()].some((ask) => ask.kind === "notice" || ask.kind === "question" || ask.confirmedAt)) return;
  actor.asks.set(`notice:${record.id}`, { kind: "notice", at: record.at, waitingOn: new Set(actor.calls.keys()), message: record.message || "" });
}

/**
 * A new call or request from the agent after a notice confirmed a prompt: the agent has moved on, so
 * the prompt was answered (approved and still running, or denied, which never gets a result). Calls
 * started before the notice are parallel ones and say nothing about it.
 */
function dropAnswered(actor, record) {
  const call = callOf(record);
  for (const [key, ask] of actor.asks) {
    const since = ask.kind === "notice" ? ask.at : ask.kind === "permission" ? ask.confirmedAt : 0;
    if (since && record.at > since && !(ask.kind === "permission" && sameCall(ask, call))) actor.asks.delete(key);
  }
}

function settleAsks(actor, record) {
  const finished = record.event === "PostToolUse" || record.event === "PostToolUseFailure";
  const callKey = finished ? openCallKey(actor, record) || record.toolUse : "";
  if (record.event === "PreToolUse") dropAnswered(actor, record);
  for (const [key, ask] of actor.asks) {
    if (ask.kind !== "notice") {
      if (finished && sameCall(ask, callOf(record))) actor.asks.delete(key);
      continue;
    }
    if (record.event === "Notification") { actor.asks.delete(key); continue; }
    // A notice with nothing running when it arrived is answered by the next sign of progress.
    if (!ask.waitingOn.size) { actor.asks.delete(key); continue; }
    if (finished && callKey) {
      ask.waitingOn.delete(callKey);
      if (!ask.waitingOn.size) actor.asks.delete(key);
    }
  }
}

function resolveAsks(actor) {
  actor.asks.clear();
  actor.calls.clear();
  actor.finished.clear();
}

/** Follow the plan: a TodoWrite replaces the list; TaskCreate and TaskUpdate change one task at a time. */
function notePlan(actor, record) {
  if (record.event === "PreToolUse" && record.tool === "TodoWrite" && Array.isArray(record.todos)) {
    actor.todos = record.todos;
    actor.plan = "todos";
    return;
  }
  const task = record.task;
  const draft = `call:${record.toolUse || record.id}`;
  if (record.tool === "TaskCreate") {
    if (record.event === "PreToolUse" && task?.subject) actor.tasks.set(draft, { subject: task.subject, status: "pending" });
    else if (record.event === "PostToolUseFailure") actor.tasks.delete(draft);
    else if (record.event === "PostToolUse" && task?.id) {
      const created = actor.tasks.get(draft);
      actor.tasks.delete(draft);
      actor.tasks.set(task.id, { subject: created?.subject || `Task ${task.id}`, status: created?.status || "pending" });
    } else return;
  } else if (record.tool === "TaskUpdate" && record.event === "PreToolUse" && task?.id) {
    if (task.status === "deleted") actor.tasks.delete(task.id);
    else {
      const current = actor.tasks.get(task.id) || { subject: `Task ${task.id}`, status: "pending" };
      actor.tasks.set(task.id, { subject: task.subject || current.subject, status: task.status || current.status });
    }
  } else return;
  actor.plan = "tasks";
  while (actor.tasks.size > 100) actor.tasks.delete(actor.tasks.keys().next().value);
}

function openTurn(actor, record) {
  if (actor.openTurn) return actor.openTurn;
  const turn = { id: `turn-${record.id}`, status: "inProgress", startedAt: record.at, questions: [], error: "" };
  actor.turns.push(turn);
  actor.openTurn = turn;
  return turn;
}

/**
 * End the open turn as "completed", "failed", or "interrupted" (Esc, a denied permission, or the session
 * closing mid-turn: Claude Code went back to its prompt without a Stop). An interrupted turn says
 * "Stopped before it finished." and its open steps are "stopped": a denied command never ran.
 */
function closeTurn(actor, status, record = null) {
  // The end of a turn (or of the session) answers whatever it was waiting on.
  resolveAsks(actor);
  const turn = actor.openTurn;
  if (!turn) return null;
  turn.status = status;
  turn.endedAt = record?.at || 0;
  actor.openTurn = null;
  // Steps still open when the turn ends are over; a lost PostToolUse must not leave a goblin swinging forever.
  const ended = status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "completed";
  for (const activity of actor.activities) if (activity.turnId === turn.id && activity.status === "inProgress") activity.status = ended;
  if (status === "interrupted" && record) {
    addActivity(actor, turn, record, { id: `claude-${record.id}${actor.agent ? `:${actor.agent}` : ""}:stopped`, kind: "update", title: "Status",
      description: "Stopped before it finished." });
  }
  return turn;
}

function addActivity(actor, turn, record, fields) {
  const activity = { id: `claude-${record.id}`, turnId: turn.id, turnStartedAt: turn.startedAt, order: actor.order++, detail: "", status: "completed", ...fields };
  actor.activities.push(activity);
  return activity;
}

/** Whether a tool's finished calls add up as lookups ("Read 3 files"): "read", "search", or "". */
const lookupKind = (tool) => (FILE_TOOLS[tool] === "read" ? "read" : tool === "Grep" || tool === "Glob" ? "search" : "");

/**
 * Remember the newest finished step, so a goblin with nothing running still says what it last did
 * ("Ran npm test", "Edited server.mjs") instead of "Thinking". Reads and searches that finish one after
 * another in the same turn add up ("Read 3 files"), as the detail's trail groups them.
 */
function noteDone(actor, call, record) {
  const lookup = lookupKind(call.tool);
  const turn = actor.openTurn?.id || "";
  const previous = actor.lastDone;
  const counts = lookup && previous?.lookup && previous.turn === turn ? { reads: previous.reads, searches: previous.searches } : { reads: 0, searches: 0 };
  if (lookup === "read") counts.reads++;
  if (lookup === "search") counts.searches++;
  actor.lastDone = { tool: call.tool || "", target: call.target || "", detail: call.detail || "", agentKind: call.agentKind || "",
    at: record.at, failed: record.event === "PostToolUseFailure", turn, lookup: Boolean(lookup), background: call.background === true, ...counts };
}

function applyRecord(actor, record) {
  actor.updatedAt = Math.max(actor.updatedAt, record.at);
  actor.lastEvent = record.event;
  if (record.cwd) actor.cwd = record.cwd;
  if (record.agentType && !actor.agentType) actor.agentType = record.agentType;
  if (record.model) actor.model = record.model;
  if (record.transcript) actor.transcript = record.transcript;
  if (record.agentTranscript) actor.agentTranscript = record.agentTranscript;
  if (record.event === "PermissionRequest") {
    dropAnswered(actor, record);
    addCallAsk(actor, record, record.tool === "AskUserQuestion" ? "question" : "permission");
    return;
  }
  if (record.event === "Notification" && NEEDS_NOTICES.has(record.notice)) { addNotice(actor, record); return; }
  settleAsks(actor, record);
  switch (record.event) {
    case "SessionStart":
      resolveAsks(actor);
      actor.ended = false;
      // A resumed, cleared, or compacted conversation starts over: the last reply's question was answered or left behind.
      if (actor.turns.length) actor.turns.at(-1).questions = [];
      // A cleared conversation starts with an empty plan.
      if (record.start === "clear") { actor.plan = ""; actor.todos = []; actor.tasks.clear(); }
      break;
    case "UserPromptSubmit":
      closeTurn(actor, "completed", record);
      actor.ended = false;
      openTurn(actor, record);
      break;
    case "SubagentStart":
      openTurn(actor, record);
      break;
    case "PreToolUse": {
      const turn = openTurn(actor, record);
      const key = record.toolUse || record.id;
      const activity = addActivity(actor, turn, record, { ...toolActivity(record.tool, record.target), status: "inProgress" });
      actor.tools.set(key, activity);
      actor.calls.set(key, { ...callOf(record), key });
      // A permission request stamped a moment before its own call takes the call's id now.
      if (record.toolUse) for (const ask of actor.asks.values()) if (ask.kind !== "notice" && !ask.toolUse && sameCall(ask, callOf(record))) ask.toolUse = record.toolUse;
      if (record.tool === "AskUserQuestion") addCallAsk(actor, record, "question");
      notePlan(actor, record);
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const status = record.event === "PostToolUse" ? "completed" : "failed";
      const key = openCallKey(actor, record);
      // The call as its PreToolUse named it (a result carries no command or path of its own).
      noteDone(actor, actor.calls.get(key) || callOf(record), record);
      actor.calls.delete(key);
      if (record.toolUse) actor.finished.set(record.toolUse, record.at);
      if (record.sig) actor.finished.set(`sig:${record.sig}`, record.at);
      while (actor.finished.size > 200) actor.finished.delete(actor.finished.keys().next().value);
      notePlan(actor, record);
      const existing = actor.tools.get(record.toolUse || key);
      if (existing) { existing.status = status; break; }
      const turn = openTurn(actor, record);
      addActivity(actor, turn, record, { ...toolActivity(record.tool, record.target), status });
      break;
    }
    case "Stop":
    case "SubagentStop": {
      const turn = actor.openTurn || openTurn(actor, record);
      if (record.message) addActivity(actor, turn, record, { kind: "update", title: "Answer", description: record.message });
      // A subagent's last message goes to its parent, never to the person: only the session's own reply asks.
      if (record.question && record.event === "Stop" && !actor.agent) turn.questions = [record.question];
      closeTurn(actor, "completed", record);
      break;
    }
    case "StopFailure": {
      const turn = actor.openTurn || openTurn(actor, record);
      const description = ERROR_TEXT[record.errorType] || "Claude Code stopped with an error.";
      turn.error = description;
      addActivity(actor, turn, record, { kind: "update", title: "Stopped", description, status: "failed" });
      closeTurn(actor, "failed", record);
      break;
    }
    case "SessionEnd":
      closeTurn(actor, "interrupted", record);
      actor.ended = true;
      break;
    case "Notification":
      // Back at the prompt: a turn still open was interrupted or denied, not failed, and nothing it
      // asked is still waiting. A finished reply's closing question is kept; it was already closed.
      if (record.notice === IDLE_NOTICE) closeTurn(actor, "interrupted", record);
      break;
    default:
      break;
  }
}

/** needs | failed | working | quiet, the same feed classes Codex and Orca members use. */
export function classifyClaude(actor, { now = Date.now(), askMs = CLAUDE_LIMITS.askMs, failedMs = CLAUDE_LIMITS.failedMs } = {}) {
  if (actor?.needsInput) return "needs";
  const last = actor?.turnStates?.at(-1);
  // A finished reply that ends in a question waits on the person, as a Codex one does.
  if (last?.questions?.length && Number(actor.updatedAt) >= now - askMs) return "needs";
  // An old failure with nothing after it is history, not something to do: the person moved on.
  if (String(last?.status || "") === "failed") return Number(actor.updatedAt) >= now - failedMs ? "failed" : "quiet";
  if (String(last?.status || "") === "inProgress") return "working";
  return "quiet";
}

/** What a permission prompt asks, in plain words: "Allow Read to open notes.md?". */
export function permissionText({ tool = "", target = "", detail = "", agentKind = "" } = {}) {
  const file = target || "a file";
  if (SHELL_TOOLS.has(tool)) return `Allow ${tool} to run this command?`;
  if (FILE_TOOLS[tool] === "read") return `Allow ${tool} to open ${file}?`;
  if (tool === "Write") return `Allow Write to create or replace ${file}?`;
  if (FILE_TOOLS[tool] === "edit") return `Allow ${tool} to change ${file}?`;
  if (tool === "WebFetch") return `Allow WebFetch to open ${detail ? hostOf(detail) : "a web page"}?`;
  if (tool === "WebSearch") return "Allow WebSearch to search the web?";
  if (tool === "Grep" || tool === "Glob") return `Allow ${tool} to search the files?`;
  if (tool === "Agent" || tool === "Task") return `Allow Claude Code to start ${agentKind ? `a ${agentKind}` : "a"} subagent?`;
  if (tool === "Skill") return `Allow Claude Code to use the ${firstLine(detail, 40) || "requested"} skill?`;
  const mcp = mcpName(tool);
  if (mcp) return `Allow Claude Code to use ${mcp.server} · ${mcp.tool}?`;
  return `Allow Claude Code to use ${tool || "a tool"}?`;
}

const baseName = (path) => String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || "";

/** What one open tool call is doing, as a roster line: "Running npm test", "Editing server.mjs". */
export function callNow({ tool = "", target = "", detail = "", agentKind = "", at = 0 } = {}) {
  const file = target || baseName(detail) || "a file";
  const line = (kind, title) => makeNow({ kind, title, detail, startedAt: at });
  if (SHELL_TOOLS.has(tool) || tool === "BashOutput" || tool === "KillShell") return line("command", `Running ${firstLine(detail) || "a command"}`);
  if (FILE_TOOLS[tool] === "read") return line("read", `Reading ${file}`);
  if (tool === "Write") return line("write", `Writing ${file}`);
  if (FILE_TOOLS[tool] === "edit") return line("edit", `Editing ${file}`);
  if (tool === "Grep" || tool === "Glob") return line("search", `Searching ${firstLine(detail) || "the files"}`);
  if (tool === "WebFetch") return line("web", `Fetching ${detail ? hostOf(detail) : "a web page"}`);
  if (tool === "WebSearch") return line("web", detail ? `Searching the web for ${firstLine(detail, 50)}` : "Searching the web");
  if (tool === "Agent" || tool === "Task") return line("agent", `Subagent ${firstLine(detail) || agentKind || "at work"}`);
  if (tool === "AskUserQuestion") return line("ask", "Asking you a question");
  if (tool === "TodoWrite" || tool === "TaskCreate" || tool === "TaskUpdate") return line("tool", "Updating the plan");
  if (tool === "Skill") return line("tool", `Using the ${firstLine(detail, 40) || "requested"} skill`);
  const mcp = mcpName(tool);
  return line("tool", mcp ? `Using ${mcp.server} · ${mcp.tool}` : `Using ${tool || "a tool"}`);
}

/**
 * The newest finished step as a roster line, in the past tense: "Ran npm test", "Edited server.mjs",
 * "Read 3 files". `done: true`, and `startedAt` is when it finished, so the window says "2m ago". A
 * subagent or command started in the background has only started ("Started in the background: …").
 */
export function doneNow({ tool = "", target = "", detail = "", agentKind = "", at = 0, failed = false, reads = 0, searches = 0, background = false } = {}) {
  const line = (kind, title, exact = detail) => makeNow({ kind, title: failed ? `${title} · failed` : title, detail: exact, startedAt: at, done: true });
  if (background && (tool === "Agent" || tool === "Task")) return line("agent", `Started in the background: ${firstLine(detail) || agentKind || "a subagent"}`);
  if (background && SHELL_TOOLS.has(tool)) return line("command", `Started ${firstLine(detail) || "a command"} in the background`);
  if (reads + searches > 1) {
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const title = reads && searches ? `Read ${plural(reads, "file", "files")} and searched ${plural(searches, "time", "times")}`
      : reads ? `Read ${reads} files` : `Searched ${searches} times`;
    return line(reads ? "read" : "search", title, "");
  }
  const file = target || baseName(detail) || "a file";
  if (SHELL_TOOLS.has(tool) || tool === "BashOutput" || tool === "KillShell") return line("command", `Ran ${firstLine(detail) || "a command"}`);
  if (FILE_TOOLS[tool] === "read") return line("read", `Read ${file}`);
  if (tool === "Write") return line("write", `Wrote ${file}`);
  if (FILE_TOOLS[tool] === "edit") return line("edit", `Edited ${file}`);
  if (tool === "Grep" || tool === "Glob") return line("search", `Searched ${firstLine(detail) || "the files"}`);
  if (tool === "WebFetch") return line("web", `Fetched ${detail ? hostOf(detail) : "a web page"}`);
  if (tool === "WebSearch") return line("web", detail ? `Searched the web for ${firstLine(detail, 50)}` : "Searched the web");
  if (tool === "Agent" || tool === "Task") return line("agent", `Subagent finished: ${firstLine(detail) || agentKind || "its task"}`);
  if (tool === "AskUserQuestion") return line("tool", "Got your answer");
  if (tool === "TodoWrite" || tool === "TaskCreate" || tool === "TaskUpdate") return line("tool", "Updated the plan");
  if (tool === "Skill") return line("tool", `Used the ${firstLine(detail, 40) || "requested"} skill`);
  const mcp = mcpName(tool);
  return line("tool", mcp ? `Used ${mcp.server} · ${mcp.tool}` : `Used ${tool || "a tool"}`);
}

// The events after which a goblin's newest visible step is the one that just finished.
const FINISH_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);

/**
 * The ask a Claude actor shows: the oldest pending request (Claude Code shows them in that order), or,
 * when only a notice arrived (older hooks capture no request), a plain "waiting for your answer" with
 * the newest open call's command when there is one. Answering always happens in Claude Code.
 */
function claudeAsk(id, pending, state) {
  const captured = pending.find((ask) => ask.kind !== "notice");
  if (captured?.kind === "question" || captured?.tool === "AskUserQuestion") {
    const questions = (captured.asks || []).map((item) => ({ text: item.q, options: item.options }));
    return makeAsk(id, { kind: "question", text: questions[0]?.text || "Claude Code is asking you a question.", questions,
      tool: "AskUserQuestion", at: captured.at });
  }
  if (captured) return makeAsk(id, { kind: "permission", text: permissionText(captured), command: captured.detail, tool: captured.tool, at: captured.at });
  const open = [...state.calls.values()].sort((a, b) => b.at - a.at)[0];
  // The notice's own words ("Claude needs your permission to use Bash"), when Claude Code sent any.
  const said = pending.find((ask) => ask.message)?.message;
  return makeAsk(id, { kind: "permission", text: said || "Claude Code is waiting for your answer.", command: open?.detail, tool: open?.tool, at: pending[0].at });
}

/** Plan progress from the newest todo list or task list. */
function claudeProgress(state) {
  if (state.plan === "tasks") return planProgress([...state.tasks.values()], (task) => task.subject);
  if (state.plan === "todos") return planProgress(state.todos, (todo) => todo.t);
  return null;
}

const withoutQuestions = (turnStates) => turnStates.map((turn, index) => (index === turnStates.length - 1 ? { ...turn, questions: [] } : turn));

function toActor(state, { now, limits, sessionName, sessionUpdatedAt = state.updatedAt }) {
  const isChild = Boolean(state.agent);
  const turns = state.turns.map((turn) => ({ ...turn }));
  const last = turns.at(-1);
  // An ask stops alerting once the whole session has been quiet for askMs; the session ending clears it.
  const fresh = now - Math.max(state.updatedAt, sessionUpdatedAt) <= limits.askMs;
  // A permission request no notice confirmed was most likely approved at once; it asks only briefly.
  const unconfirmedMs = limits.unconfirmedMs ?? CLAUDE_LIMITS.unconfirmedMs;
  const live = (ask) => ask.kind !== "permission" || ask.confirmedAt || now - ask.at <= unconfirmedMs;
  const pending = [...state.asks.values()].filter(live).sort((a, b) => a.at - b.at);
  const needsInput = fresh && pending.length > 0;
  const open = [...state.calls.values()].sort((a, b) => b.at - a.at)[0];
  const quietFor = now - state.updatedAt;
  // A turn left open with nothing running and nothing heard for idleMs is not working: Esc or a closed
  // terminal sends no hook. Something asking the person, or a call still open (a long test run), keeps it,
  // except a shell command quiet for shellMs: Claude Code's shell tool cannot run that long, so its
  // session was closed or interrupted mid-command.
  const shellOver = Boolean(open) && [...state.calls.values()].every((call) => SHELL_TOOLS.has(call.tool))
    && quietFor > (limits.shellMs ?? CLAUDE_LIMITS.shellMs);
  const idle = last?.status === "inProgress" && !state.ended && (!open || shellOver) && !needsInput && quietFor > (limits.idleMs ?? CLAUDE_LIMITS.idleMs);
  const stale = !idle && last?.status === "inProgress" && quietFor > limits.staleMs;
  if (stale) last.status = "stale";
  if (idle) last.status = "idle";
  const activities = state.activities.slice(-limits.activities).map((activity) => ((stale || idle) && activity.status === "inProgress" ? { ...activity, status: "completed" } : { ...activity }));
  const status = needsInput ? "waiting" : idle ? "idle" : stale ? "stale" : last?.status === "inProgress" ? "active"
    : last?.status === "failed" ? "failed" : state.ended ? "ended" : last?.status === "interrupted" ? "stopped" : last ? "completed" : "idle";
  const typeLabel = state.agentType || (isChild ? "helper" : "");
  const nickname = isChild ? clip(`${typeLabel[0].toUpperCase()}${typeLabel.slice(1)} subagent`, 70) : "Claude Code";
  const id = isChild ? claudeChildId(state.session, state.agent) : claudeMainId(state.session);
  const actor = {
    id, source: "claude", name: isChild ? nickname : sessionName, nickname,
    role: isChild ? `Claude subagent · ${typeLabel}` : `Claude Code${state.agentType ? ` · ${state.agentType}` : ""}`,
    parentThreadId: claudePartyId(state.session),
    ...(isChild ? { childOf: claudeMainId(state.session), agentType: state.agentType } : {}),
    cwd: state.cwd, model: describeModel(state.model, { provider: "anthropic" }), status, updatedAt: state.updatedAt, turns: state.turns.length,
    turnStates: turns.slice(-limits.turns).map(({ id, status: turnStatus, questions, error }) => ({ id, status: turnStatus, questions, error })),
    activities, latest: activities.at(-1) || null,
    counts: {
      ...emptyCounts(),
      updates: activities.filter((item) => item.kind === "update").length,
      commands: activities.filter((item) => item.kind === "command").length,
      research: activities.filter((item) => item.kind === "research").length,
      tools: activities.filter((item) => item.kind === "tool" || item.kind === "file").length,
    },
    needsInput, replyAvailable: false,
  };
  // A finished reply's closing question asks the person too, but only the session's own (subagents answer
  // their parent), only while the session is open, and only for askMs from when it was asked: activity
  // elsewhere in the session does not make an old question new.
  const repliedAt = last?.endedAt || state.updatedAt;
  const replied = !isChild && !state.ended && last?.status !== "inProgress" && last?.questions?.length && now - repliedAt <= limits.askMs;
  actor.ask = needsInput ? claudeAsk(id, pending, state)
    : replied ? makeAsk(id, { kind: "reply", text: last.questions.at(-1), at: repliedAt }) : null;
  // Now: the newest open call; else, for doneMs, the step that just finished; else Thinking, timed from
  // the newest hook (how long it has been quiet), never from when the turn began or Thinking was first seen.
  const doneMs = limits.doneMs ?? CLAUDE_LIMITS.doneMs;
  const justDone = state.lastDone && state.lastDone.turn === last?.id && FINISH_EVENTS.has(state.lastEvent) && now - state.lastDone.at <= doneMs;
  actor.now = last?.status !== "inProgress" || state.ended ? null
    : open ? callNow(open) : justDone ? doneNow(state.lastDone) : makeNow({ kind: "think", title: "Thinking", startedAt: state.updatedAt });
  // An idle goblin says how long it has been quiet ("No activity for 66m"), from this time.
  if (idle) actor.idleSince = state.updatedAt;
  actor.progress = claudeProgress(state);
  // Needs-you exactly when there is something to answer; otherwise the usual working, failed, or quiet.
  actor.attention = actor.ask ? "needs" : classifyClaude({ ...actor, needsInput: false, turnStates: withoutQuestions(actor.turnStates) }, { now, askMs: limits.askMs });
  return actor;
}

// Which members a cap keeps first: someone waiting on the person, then failures, then work in progress.
const ATTENTION_RANK = { needs: 0, failed: 1, waiting: 2, working: 3, quiet: 4 };
const rankOf = (actor) => ATTENTION_RANK[actor?.attention] ?? ATTENTION_RANK.quiet;
export const partyRank = (actors) => Math.min(ATTENTION_RANK.quiet, ...actors.map(rankOf));

/** Keep at most `limit` items, most urgent first and then newest; the kept ones stay newest first. */
export function keepMostUrgent(items, limit, rank = rankOf) {
  if (items.length <= limit) return { kept: [...items].sort((a, b) => b.updatedAt - a.updatedAt), hidden: [] };
  const ordered = [...items].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  return { kept: ordered.slice(0, limit).sort((a, b) => b.updatedAt - a.updatedAt), hidden: ordered.slice(limit) };
}

/** How many actors a cut left out, and how many of those were active or urgent. */
export function countActors(actors) {
  return {
    agents: actors.length,
    active: actors.filter((actor) => rankOf(actor) < ATTENTION_RANK.quiet).length,
    urgent: actors.filter((actor) => rankOf(actor) <= ATTENTION_RANK.failed).length,
  };
}

/** Totals left out across parties: whole parties that were cut, plus members cut from kept ones. */
export function truncatedCounts(kept, hidden) {
  const total = { parties: hidden.length, agents: 0, active: 0, urgent: 0 };
  const add = (counts) => { total.agents += counts.agents; total.active += counts.active; total.urgent += counts.urgent; };
  for (const party of hidden) { add(countActors(party.agents)); add(party.hidden); }
  for (const party of kept) add(party.hidden);
  return total;
}

// Prompts and replies kept per session to tell which Orca pane it runs in.
const RECENT_WORDS = 6;

/**
 * A needs-you notice with no agent id is the prompt of whichever goblin in the session asked. A
 * dialog-still-open notice confirms the permission requests still waiting among them, the session's own
 * and its subagents' (see confirmAsks); otherwise a subagent's request already says what is asked, so no
 * second ask is added; otherwise it is the session goblin's own notice.
 */
function routeNotice(session, record) {
  const bump = (actor) => { actor.updatedAt = Math.max(actor.updatedAt, record.at); };
  if (CONFIRM_NOTICES.has(record.notice)) {
    const confirmed = new Set(confirmAsks([session.main, ...session.children.values()], record).map(([actor]) => actor));
    if (confirmed.size) {
      for (const actor of confirmed) if (actor !== session.main) bump(actor);
      // The session's own goblin takes the notice as its newest event; nothing is left for it to confirm.
      if (confirmed.has(session.main)) applyRecord(session.main, record);
      else bump(session.main);
      return;
    }
  }
  if ([...session.children.values()].some((child) => [...child.asks.values()].some((ask) => ask.kind !== "notice"))) bump(session.main);
  else applyRecord(session.main, record);
}

/**
 * Rebuild sessions from records already in time order. Pure apart from `names`, so tests can drive it
 * directly. `names({ session, cwd, transcript })`, when given, is asked for what a session's own
 * transcript calls it ({ custom, derived, derivedAt } or null; see ClaudeTitleReader), only for sessions
 * active within `limits.namesMs` (the ones the scene can show): a session whose prompts the hook never
 * recorded is then named for its work instead of "Claude · <folder> · <id>".
 * Returns { sessions, truncated }: truncated counts what the session and subagent caps left out.
 */
export function buildClaudeFeed(records, { now = Date.now(), limits = CLAUDE_LIMITS, names = null } = {}) {
  const sessions = new Map();
  for (const record of records) {
    let session = sessions.get(record.session);
    if (!session) {
      session = { id: record.session, cwd: record.cwd || "", startedAt: record.at, updatedAt: record.at, main: null, children: new Map(), words: [],
        title: "", titleAt: 0, spawns: [], tasks: new Map(), background: new Set() };
      sessions.set(record.session, session);
    }
    session.updatedAt = Math.max(session.updatedAt, record.at);
    if (record.cwd) session.cwd = record.cwd;
    // The session is named for the first prompt that says what it is for; follow-ups and nudges never rename it.
    const titled = !record.agent && record.event === "UserPromptSubmit" && !session.title ? promptTitle(record.prompt) : "";
    if (titled) Object.assign(session, { title: titled, titleAt: record.at });
    noteSpawn(session, record);
    // The session's own newest prompts and replies: an Orca pane reporting the same words is this session.
    const words = !record.agent && (record.event === "UserPromptSubmit" ? record.prompt : record.event === "Stop" ? record.message : "");
    if (words) session.words = [...session.words, words].slice(-RECENT_WORDS);
    // Subagent lifecycle and steps belong to the child; everything else to the session's own goblin.
    const childEvent = record.agent && record.event !== "SessionStart" && record.event !== "SessionEnd" && record.event !== "UserPromptSubmit";
    if (childEvent) {
      let child = session.children.get(record.agent);
      if (!child) {
        child = newActor(record.session, record.agent, record);
        session.children.set(record.agent, child);
        claimSpawn(session, record.agent, record.agentType);
      }
      applyRecord(child, record);
    } else {
      session.main ||= newActor(record.session, "", record);
      if (record.event === "Notification" && NEEDS_NOTICES.has(record.notice)) routeNotice(session, record);
      else applyRecord(session.main, record);
      // The session ending ends every subagent; back at the prompt ends only those its turn was waiting on,
      // never one started in the background.
      if (record.event === "SessionEnd" || record.notice === IDLE_NOTICE) {
        for (const [agent, child] of session.children) {
          if (record.event === "SessionEnd" || !session.background.has(agent)) closeTurn(child, "interrupted", record);
        }
      }
    }
  }
  // Names from the sessions' own transcripts, asked for newest session first: the reader reads only a few
  // per scene, and those go to the sessions most likely on screen.
  const namesMs = limits.namesMs ?? CLAUDE_LIMITS.namesMs;
  const transcriptNamed = new Map();
  if (typeof names === "function") {
    for (const session of [...sessions.values()].filter((item) => now - item.updatedAt <= namesMs).sort((a, b) => b.updatedAt - a.updatedAt)) {
      transcriptNamed.set(session.id, names({ session: session.id, cwd: session.cwd, transcript: session.main?.transcript || "" }));
    }
  }
  // Every actor is classified before any cut, so the caps drop quiet history, never someone waiting.
  const built = [...sessions.values()].filter((session) => !limits.catalogMs || now - session.updatedAt <= limits.catalogMs).map((session) => {
    const project = projectName(session.cwd);
    const named = transcriptNamed.get(session.id) ?? null;
    // Named for what it was asked to do; the folder stays visible as the goblin's project.
    const name = sessionTitle({ hook: session.title, hookAt: session.titleAt }, named)
      || `Claude · ${project || "session"} · ${shortHash(session.id)}`;
    const options = { now, limits, sessionName: name, sessionUpdatedAt: session.updatedAt };
    const main = session.main ? toActor(session.main, options) : null;
    const children = [...session.children].map(([agent, child]) => namedForTask(toActor(child, options), session.tasks.get(agent)));
    // The session's own goblin always stays; subagents fill the remaining places by urgency, then recency.
    const { kept, hidden } = keepMostUrgent(children, Math.max(0, limits.children));
    return {
      id: claudePartyId(session.id), session: session.id, name, cwd: session.cwd, startedAt: session.startedAt, updatedAt: session.updatedAt,
      agents: [...(main ? [main] : []), ...kept], hidden: countActors(hidden), rank: partyRank([...(main ? [main] : []), ...children]),
      words: session.words,
    };
  });
  const { kept, hidden } = keepMostUrgent(built, limits.sessions, (session) => session.rank);
  return { sessions: kept.map(({ rank, ...session }) => session), truncated: truncatedCounts(kept, hidden) };
}

/** Rebuild sessions from records already in time order. Pure, so tests can drive it directly. */
export function buildClaudeSessions(records, options) {
  return buildClaudeFeed(records, options).sessions;
}

/**
 * Parse stored lines: malformed, oversized, foreign, and repeated records are skipped. A record already
 * cleaned on an earlier read (`memo`: id -> record) is reused, so a log that grew by one line is not
 * filtered again from the start; every record kept is added to `kept` for the next read.
 */
export function parseClaudeLines(text, { limits = CLAUDE_LIMITS, seen = new Set(), memo = null, kept = null } = {}) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    if (line.length > limits.lineChars) { skipped++; continue; }
    let record;
    try {
      const raw = JSON.parse(line);
      record = (typeof raw?.id === "string" && memo?.get(raw.id)) || cleanRecord(raw);
    } catch { record = null; }
    if (!record) { skipped++; continue; }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    kept?.set(record.id, record);
    records.push(record);
  }
  return { records, skipped };
}

/**
 * Each session's and subagent's newest prompt, todo list, transcript paths, and Orca identity, kept apart from the
 * shared record window. Every session's hooks share the newest `records` (6000), so a long turn in a
 * busy hour loses its prompt and plan from that window while it still runs; the detail view falls back
 * on these (recordedMissionAndPlan, recordedTranscript). Only already-filtered records are kept, at most
 * four per session or subagent, for the newest `sessions` sessions; it lives in memory only, so it also
 * outlasts a log that rolled over.
 */
export class ClaudeRecordIndex {
  constructor({ sessions = 200 } = {}) {
    this.limit = sessions;
    this.sessions = new Map(); // session -> { at, agents: Map(agent -> { prompt, todos, transcript, agentTranscript }) }
  }

  add(record) {
    const kinds = [];
    if (!record.agent && record.event === "UserPromptSubmit" && record.prompt) kinds.push("prompt");
    if (record.event === "PreToolUse" && Array.isArray(record.todos)) kinds.push("todos");
    if (record.transcript) kinds.push("transcript");
    if (record.agent && record.agentTranscript) kinds.push("agentTranscript");
    // The Orca terminal a session runs in, which the task view groups by.
    if (!record.agent && record.orca) kinds.push("orca");
    if (!kinds.length) return;
    let session = this.sessions.get(record.session);
    if (session) this.sessions.delete(record.session); // Kept in order of the newest record.
    else session = { at: 0, agents: new Map() };
    session.at = Math.max(session.at, record.at);
    this.sessions.set(record.session, session);
    const agent = session.agents.get(record.agent || "") || {};
    for (const kind of kinds) if (!agent[kind] || agent[kind].at <= record.at) agent[kind] = record;
    session.agents.set(record.agent || "", agent);
    while (this.sessions.size > this.limit) this.sessions.delete(this.sessions.keys().next().value);
    while (session.agents.size > 50) session.agents.delete(session.agents.keys().next().value);
  }

  /** The kept records, oldest first. */
  records() {
    const kept = new Set();
    for (const session of this.sessions.values()) for (const agent of session.agents.values()) for (const record of Object.values(agent)) kept.add(record);
    return [...kept].sort((a, b) => a.at - b.at);
  }
}

export class ClaudeReader {
  /**
   * `titles`: an optional ClaudeTitleReader (lib/claude-detail.mjs) that names sessions from their own
   * transcripts; it bounds its own reads per snapshot.
   */
  constructor({ dir = claudeActivityDir(), ttlMs = 1000, limits = CLAUDE_LIMITS, clock = Date.now, titles = null } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.limits = limits;
    this.clock = clock;
    this.titles = titles;
    this.cached = null;
    this.cachedAt = 0;
    this.fingerprint = "";
    this.records = [];
    this.memo = new Map(); // Records cleaned on the last read, by id.
    this.index = new ClaudeRecordIndex();
  }

  /**
   * The records the detail view looks in for a session's prompt, plan, and transcript paths: the shared
   * window, after what the index kept from before it (see ClaudeRecordIndex). Local use only.
   */
  detailRecords() {
    this.snapshot();
    const inWindow = new Set(this.records.map((record) => record.id));
    return [...this.index.records().filter((record) => !inWindow.has(record.id)), ...this.records];
  }

  readFiles() {
    const texts = [];
    let fingerprint = "";
    let warning = "";
    for (const name of ["activity.1.jsonl", "activity.jsonl"]) {
      const file = join(this.dir, name);
      try {
        const info = statSync(file);
        fingerprint += `${name}:${info.size}:${info.mtimeMs};`;
        // Bounded reads: anything past twice the roll-over size is read from its newest end.
        texts.push(readFileTail(file, this.limits.rotateBytes * 2));
      } catch (error) {
        if (error.code !== "ENOENT") warning = "Claude Code activity could not be read.";
      }
    }
    return { texts, fingerprint, warning };
  }

  snapshot() {
    const now = this.clock();
    if (this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    const { texts, fingerprint, warning } = this.readFiles();
    if (fingerprint !== this.fingerprint) {
      const seen = new Set();
      const kept = new Map();
      const parsed = texts.flatMap((text) => parseClaudeLines(text, { limits: this.limits, seen, memo: this.memo, kept }).records);
      this.memo = kept;
      // Hooks for parallel tools can land a moment out of order; a stable sort keeps ties in file order.
      parsed.sort((a, b) => a.at - b.at);
      for (const record of parsed) this.index.add(record);
      this.records = parsed.slice(-this.limits.records);
      this.fingerprint = fingerprint;
    }
    const titles = this.titles;
    try { titles?.startPoll?.(); } catch { /* Names are optional. */ }
    const names = titles ? (info) => { try { return titles.title(info); } catch { return null; } } : null;
    const { sessions, truncated } = buildClaudeFeed(this.records, { now, limits: this.limits, names });
    this.cached = { sessions, truncated, warning, recordCount: this.records.length };
    this.cachedAt = now;
    return this.cached;
  }

  /**
   * Every session and subagent the hook log holds, uncapped, for the task view: the scene keeps the most
   * urgent `sessions` sessions and `children` subagents each, which a day of work can exceed. Built at
   * most once per snapshot, from the same records.
   */
  taskFeed() {
    const snapshot = this.snapshot();
    if (this.taskCache?.snapshot === snapshot) return this.taskCache.sessions;
    const titles = this.titles;
    const names = titles ? (info) => { try { return titles.title(info); } catch { return null; } } : null;
    const limits = { ...this.limits, sessions: Number.MAX_SAFE_INTEGER, children: Number.MAX_SAFE_INTEGER };
    const { sessions } = buildClaudeFeed(this.records, { now: this.clock(), limits, names });
    this.taskCache = { snapshot, sessions };
    return sessions;
  }

  listSessions() {
    return this.snapshot().sessions.map(({ id, name, cwd, updatedAt, agents }) => ({ id, name, cwd, updatedAt, source: "claude", agentCount: agents.length,
      model: agents[0]?.model || null }));
  }

  scene(id) {
    if (!/^claude:[A-Za-z0-9_-]{1,128}$/.test(String(id))) return null;
    const snapshot = this.snapshot();
    const session = snapshot.sessions.find((item) => item.id === id);
    if (!session) return null;
    return {
      root: { id, source: "claude", name: session.name, cwd: session.cwd, status: session.agents[0]?.status || "unknown", updatedAt: session.updatedAt,
        turns: 0, turnStates: [], activities: [], latest: null, counts: emptyCounts() },
      agents: session.agents, requests: [], replyAvailable: false, ...partyCoverage(session, snapshot.warning, "subagent"),
    };
  }

  /**
   * A session's newest recorded prompts and replies (already filtered), so the server can prove which
   * Orca pane runs it (see claudePanePairs in lib/links.mjs). Session goblins only: a subagent is never
   * a pane of its own. Local use only; never part of a scene.
   */
  recentWords(actorId) {
    const match = /^claude-agent:([A-Za-z0-9_-]{1,128})$/.exec(String(actorId));
    if (!match) return [];
    return [...(this.snapshot().sessions.find((item) => item.session === match[1])?.words || [])];
  }
}

/** A focused party's own coverage: how many members it shows and how many the cap left out. */
export function partyCoverage(party, sourceWarning = "", noun = "member") {
  const hidden = party.hidden || { agents: 0, active: 0, urgent: 0 };
  const plural = (count) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const gap = hidden.active ? `${plural(hidden.active)} still active ${hidden.active === 1 ? "was" : "were"} left out of this party view.` : "";
  return {
    warning: [sourceWarning, gap].filter(Boolean).join(" "),
    coverage: { agentsShown: party.agents.length, agentsHidden: hidden.agents, activeHidden: hidden.active, urgentHidden: hidden.urgent,
      complete: !sourceWarning && !hidden.active },
  };
}

/**
 * The newest `maxBytes` of a file without reading the rest. When the read starts mid-file, the
 * partial first line is dropped; a tail with no line break at all is one partial line, so nothing
 * is returned. Cutting at a newline byte never splits a UTF-8 character.
 */
export function readFileTail(file, maxBytes) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (!count) break;
      read += count;
    }
    let bytes = buffer.subarray(0, read);
    if (start > 0) {
      const newline = bytes.indexOf(0x0a);
      bytes = newline < 0 ? bytes.subarray(0, 0) : bytes.subarray(newline + 1);
    }
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
