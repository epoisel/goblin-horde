/**
 * Reading a saved game a person brought from another computer, for pets-adopt.
 *
 * The path is theirs, so nothing about it is taken on trust. A network share or a device is refused from the
 * path's own text, before the disk is touched: opening a share can hang for seconds and offers this account's
 * Windows sign-in to the server it names. Then the path's real place is asked for, with every link and junction
 * in it followed, and it must be the path itself: a path that leads anywhere else goes through a link, a junction
 * or a mapped drive, and is refused whatever it leads to. The file is then opened once, and everything else is
 * asked of that one open file: that it is an ordinary file, that it is not one of this computer's own files under
 * another name, and its bytes, of which no more than the limit and one are ever read, however large the file is
 * or grows.
 */
import * as nodeFs from "node:fs";
import { resolve } from "node:path";
import { isLocalPath, samePath } from "./paths.mjs";

/** Why a file was not read. `reason` is "network", "link", "not-file", "own", "too-large" or "unreadable". */
export class SaveFileError extends Error {
  constructor(reason) {
    super(`The file was not read: ${reason}.`);
    this.name = "SaveFileError";
    this.reason = reason;
  }
}

/**
 * The text of the file at `path`, at most `limit` bytes of it. No link is followed: not one that is the file, and
 * not one in a folder above it. `own` lists files this one must not be, and the same file under a hard link
 * counts as the same. Throws a SaveFileError that says why otherwise.
 * @param {string} path
 * @param {{ limit: number, own?: string[], platform?: NodeJS.Platform, fs?: typeof nodeFs }} options
 * @returns {string}
 */
export function readSaveFile(path, { limit, own = [], platform = process.platform, fs = nodeFs }) {
  const refuse = (reason) => { throw new SaveFileError(reason); };
  const file = resolve(String(path));
  if (/^[\\/]{2}/.test(String(path)) || !isLocalPath(file, platform)) refuse("network");
  let handle;
  try {
    // The operating system's own word on where the path leads. A share reached through a mapped drive or a
    // junction shows here as \\server\share, and is refused before anything of it is opened.
    const real = (fs.realpathSync.native ?? fs.realpathSync)(file);
    if (/^[\\/]{2}/.test(real)) refuse("network");
    if (!samePath(real, file, platform)) refuse("link");
    // Asked before opening, because opening a pipe would wait for its other end. The open file is asked again below.
    if (!fs.statSync(file).isFile()) refuse("not-file");
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(handle, { bigint: true });
    if (!opened.isFile()) refuse("not-file");
    for (const mine of own) {
      const other = fs.statSync(mine, { bigint: true, throwIfNoEntry: false });
      if (other && other.dev === opened.dev && other.ino === opened.ino) refuse("own");
    }
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length; length += read) read = fs.readSync(handle, bytes, length, bytes.length - length, null);
    if (length > limit) refuse("too-large");
    return bytes.subarray(0, length).toString("utf8");
  } catch (error) {
    throw error instanceof SaveFileError ? error : new SaveFileError("unreadable");
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* Nothing more to do with it. */ } }
  }
}
