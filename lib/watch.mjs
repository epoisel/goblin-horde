/**
 * Parties the person chose to watch: always read, always on the launchpad, whatever their age.
 *
 * Everything else is read only while it is in use or when someone opens it, so a long chat history
 * never costs a slow read on every poll. The list lives in the state folder as watched.json and is
 * shared by the widget and the browser viewer.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WATCH_LIMIT = 50;
// Codex thread ids, and Claude, Orca, and extension party ids.
const PARTY_ID = /^(?:[A-Za-z0-9_-]{8,100}|claude:[A-Za-z0-9_-]{1,128}|orca:[A-Za-z0-9_-]{1,400}|ext:[A-Za-z0-9_.:\/-]{1,200})$/;

export const isPartyId = (value) => typeof value === "string" && PARTY_ID.test(value);

export class WatchList {
  constructor({ dir }) {
    this.file = join(dir, "watched.json");
    this.dir = dir;
    this.ids = [];
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      const ids = Array.isArray(saved?.ids) ? saved.ids : [];
      this.ids = [...new Set(ids.filter(isPartyId))].slice(0, WATCH_LIMIT);
    } catch { /* Nothing watched yet, or an unreadable file: start empty. */ }
  }

  has(id) { return this.ids.includes(id); }

  /** Watch or stop watching one party; newest first. Returns the list, or throws a 400 or 409. */
  set(id, watched) {
    if (!isPartyId(id)) throw Object.assign(new Error("Choose a valid chat or party."), { statusCode: 400 });
    const rest = this.ids.filter((item) => item !== id);
    if (watched && rest.length >= WATCH_LIMIT)
      throw Object.assign(new Error(`Up to ${WATCH_LIMIT} chats can be watched. Stop watching one first.`), { statusCode: 409 });
    this.ids = watched ? [id, ...rest] : rest;
    this.save();
    return this.ids;
  }

  save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ ids: this.ids })}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}
