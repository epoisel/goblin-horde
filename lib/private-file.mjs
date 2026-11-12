/**
 * Files only this account may read: the pairing code, the code a display keeps for its host, the setting that
 * turns the shared game on, and the copy kept of a saved game that could not be read.
 *
 * A file's mode means nothing on Windows. A new file takes its permissions from its folder, and a folder can
 * hand read access to every user of the computer. So a private file is made empty, its inherited permissions are
 * taken away and this account is given the file with icacls, the permissions are read back, and only when they
 * name nobody but this account, SYSTEM and Administrators is the text written and the file put in place. When
 * that cannot be done the file is not written, and what was there before stays. Elsewhere the file is made with
 * mode 0600 and the mode is read back the same way.
 *
 * icacls and whoami are run from the Windows system folder by their full paths, with arguments and no shell.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * @typedef {{ owner: string, restrict(path: string): void, readers(path: string): string[] }} Acl
 *   How one kind of computer makes a file private: `owner` is this account as `readers` names it, `restrict`
 *   takes every other account's access away, and `readers` lists who may open the file now.
 */

/** A file that could not be made private. Its message names the file and never its contents. */
export class PrivateFileError extends Error {
  constructor(file, consequence) {
    super(`${basename(file)} could not be made private to your account on this computer${consequence}.`);
    this.name = "PrivateFileError";
  }
}

// SYSTEM and Administrators, by SDDL name and by id. They can read any file on the computer whatever it says.
const ALWAYS = new Set(["SY", "BA", "S-1-5-18", "S-1-5-32-544"]);

/**
 * Who a Windows file's permissions let in, from their SDDL text: the account of each entry that allows access.
 * "?" stands for anything that is not a plain allow entry, and for permissions that cannot be read, so that what
 * is unclear is never taken for private.
 * @returns {string[]}
 */
export function readersOf(sddl) {
  const text = String(sddl ?? "");
  const dacl = /D:[A-Z_]*((?:\([^()]*\))+)/.exec(text);
  if (!dacl) return ["?"];
  const entries = [...dacl[1].matchAll(/\(([^()]*)\)/g)].map((entry) => entry[1].split(";"));
  const readers = entries.map(([type, , , object, inherited, account, ...more]) => (type === "A" && !object && !inherited && account && !more.length ? account : "?"));
  // An entry the pattern above could not take in, such as a conditional one, is still an entry.
  return text[dacl.index + dacl[0].length] === "(" ? [...readers, "?"] : readers;
}

let windowsOwner = "";

/** Windows: this account by its id, and icacls for the rest. @returns {Acl} */
function windowsAcl() {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) throw new Error("The Windows folder is not known.");
  const run = (program, args) => execFileSync(join(root, "System32", program), args, { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  windowsOwner ||= /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(run("whoami.exe", ["/user", "/fo", "csv", "/nh"]).trim())?.[1] ?? "";
  if (!windowsOwner) throw new Error("This account's id could not be read.");
  return {
    owner: windowsOwner,
    restrict: (path) => { run("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${windowsOwner}:F`]); },
    readers(path) {
      // icacls writes permissions as text only into a file, so it gets one in a folder of its own.
      const dir = mkdtempSync(join(tmpdir(), "goblin-acl-"));
      try {
        run("icacls.exe", [path, "/save", join(dir, "acl")]);
        return readersOf(readFileSync(join(dir, "acl")).toString("utf16le").trim().split(/\r?\n/).at(-1));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

/** Elsewhere: mode 0600, where "group" and "others" are whoever the mode still lets in. @returns {Acl} */
const posixAcl = () => ({
  owner: "owner",
  restrict: (path) => chmodSync(path, 0o600),
  readers(path) {
    const mode = statSync(path).mode;
    return ["owner", ...(mode & 0o070 ? ["group"] : []), ...(mode & 0o007 ? ["others"] : [])];
  },
});

function makePrivate(path, acl) {
  acl.restrict(path);
  const readers = acl.readers(path);
  if (!readers.includes(acl.owner) || !readers.every((reader) => reader === acl.owner || ALWAYS.has(reader))) throw new Error("Another account can still open the file.");
}

const aclFor = (platform) => (platform === "win32" ? windowsAcl() : posixAcl());

/**
 * Put `text` in `file` so that only this account can read it, replacing what is there. The text goes into the
 * file only after the file was made private and its permissions were read back, so it is never in a file another
 * account can open. Throws a PrivateFileError, and leaves `file` as it was, when that cannot be done.
 * @param {string} file @param {string} text @param {{ platform?: NodeJS.Platform, acl?: Acl }} [options]
 */
export function writePrivateFile(file, text, { platform = process.platform, acl } = {}) {
  const temporary = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, "", { mode: 0o600, flag: "wx" });
    makePrivate(temporary, acl ?? aclFor(platform));
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } catch {
    throw new PrivateFileError(file, ", so it was not saved");
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Make `file`, which must not be there yet, with `data` in it, readable by this account only. The file is made
 * empty and made private first, and `data` goes into it only after its permissions were read back. A name a file
 * already has is never written over: the call throws with the code EEXIST and leaves that file as it is. A new
 * file that cannot be made private is removed again, and a PrivateFileError is thrown.
 * @param {string} file @param {string | Uint8Array} data @param {{ platform?: NodeJS.Platform, acl?: Acl }} [options]
 */
export function createPrivateFile(file, data, { platform = process.platform, acl } = {}) {
  writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  try {
    try { makePrivate(file, acl ?? aclFor(platform)); } catch { throw new PrivateFileError(file, ", so it was not saved"); }
    writeFileSync(file, data);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

/**
 * Make `file`, which is already there, readable by this account only. Throws a PrivateFileError when it cannot.
 * @param {string} file @param {{ platform?: NodeJS.Platform, acl?: Acl }} [options]
 */
export function protectFile(file, { platform = process.platform, acl } = {}) {
  try { makePrivate(file, acl ?? aclFor(platform)); } catch { throw new PrivateFileError(file, ""); }
}
