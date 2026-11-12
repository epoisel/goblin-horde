/**
 * Pairing for the computers of a shared game: the pairing code and the file that keeps it, a per-address attempt
 * limit, and the session tokens a correct code earns.
 *
 * An attempt is counted the moment a request arrives, before its body is read, so guesses sent in
 * parallel cannot all pass the limit while the first ones are still being read. Everything kept here
 * has a hard bound: the live sessions, the addresses that are tracked, and how often one address may
 * pair. Old records and expired sessions are pruned as new requests come in.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./private-file.mjs";

// Eight characters with no 0/O or 1/I to misread: about 40 bits, behind a five-tries-per-ten-minutes limit.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
export const CODE_FILE = "pairing-code.txt";

/** A fresh random pairing code. */
export function newPairingCode(random = randomBytes) {
  return Array.from(random(8), (byte) => CODE_ALPHABET[byte % 32]).join("");
}

/** Save the pairing code where only this account can read it. Throws, and saves nothing, when the file cannot be made private. */
export function savePairingCode(stateDir, code) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(stateDir, CODE_FILE), `${code}\n`);
  return code;
}

/** The saved pairing code, or a new one, which is saved. */
export function loadPairingCode(stateDir) {
  try {
    const saved = readFileSync(join(stateDir, CODE_FILE), "utf8").trim();
    if (PAIRING_CODE.test(saved)) return saved;
  } catch { /* Create a code below. */ }
  return savePairingCode(stateDir, newPairingCode());
}

/**
 * The pairing code for a server that is starting. A new code that cannot be saved where only this account can
 * read it is not saved at all: the server runs on with a code for this run only, and `log` is told why.
 */
export function startingPairingCode(stateDir, { log = console } = {}) {
  try { return loadPairingCode(stateDir); } catch (failure) {
    if (failure?.name !== "PrivateFileError") throw failure;
    log.error?.(`${failure.message} A pairing code for this run only is in use.`);
    return newPairingCode();
  }
}

export class Pairing {
  /**
   * Within `windowMs`, one address gets `maxAttempts` wrong codes and `maxPairings` right ones, and at most
   * `maxPeers` addresses are tracked. At most `maxSessions` sessions live. `onePerPeer` keeps one session for
   * each address, as the shared game does, where an address is one computer: every program on that computer that
   * gives the code shares the one session.
   */
  constructor({ code, now = () => Date.now(), maxAttempts = 5, maxPairings = 8, maxPeers = 1024, maxSessions = 32, onePerPeer = false,
    windowMs = 10 * 60_000, sessionMs = 24 * 60 * 60_000 } = {}) {
    Object.assign(this, { now, maxAttempts, maxPairings, maxPeers, maxSessions, onePerPeer, windowMs, sessionMs });
    this.code = String(code || "");
    // ip -> { count, since }: the tries not yet forgiven by a right code.
    this.attempts = new Map();
    // ip -> the times of its right codes in the window.
    this.pairings = new Map();
    // token -> { ip, expiresAt }, oldest first.
    this.sessions = new Map();
  }

  /**
   * Whether `ip` may be counted at all. A full table refuses an address it does not know until the window lets
   * one go. It never drops one to make room, since that would hand an address that used up its guesses new ones.
   */
  tracks(ip) {
    return this.attempts.has(ip) || this.pairings.has(ip) || this.attempts.size + this.pairings.size < this.maxPeers;
  }

  /** The session `ip` is signed in with, where an address holds one session, or "". Ask after a prune, which drops the sessions that ran out. */
  sessionOf(ip) {
    if (!this.onePerPeer) return "";
    for (const [token, session] of this.sessions) if (session.ip === ip) return token;
    return "";
  }

  /**
   * Count one attempt from `ip`; false when this address already used up its tries or its pairings in the window.
   * An address that is signed in has no new session to earn, so its pairings do not hold it back.
   */
  allow(ip) {
    this.prune();
    if (!this.tracks(ip) || (!this.sessionOf(ip) && (this.pairings.get(ip)?.length ?? 0) >= this.maxPairings)) return false;
    const record = this.attempts.get(ip) || { count: 0, since: this.now() };
    if (record.count >= this.maxAttempts) return false;
    record.count++;
    this.attempts.set(ip, record);
    return true;
  }

  /**
   * The session token `supplied` earns when it is the code (its wrong tries are then forgotten), otherwise "".
   * Where an address holds one session, an address that is signed in is answered the session it has. Nothing new
   * is made and nothing is counted, so a second program on that computer, such as a join check beside a running
   * display, shares the display's session and never ends it.
   */
  pair(ip, supplied) {
    const given = Buffer.from(String(supplied ?? "").toUpperCase().replace(/\s/g, ""));
    const expected = Buffer.from(this.code);
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return "";
    this.prune();
    if (!this.tracks(ip)) return "";
    const signedIn = this.sessionOf(ip);
    if (signedIn) {
      this.attempts.delete(ip);
      return signedIn;
    }
    const paired = this.pairings.get(ip) ?? [];
    if (paired.length >= this.maxPairings) return "";
    this.attempts.delete(ip);
    this.pairings.set(ip, [...paired, this.now()]);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { ip, expiresAt: this.now() + this.sessionMs });
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    return token;
  }

  hasSession(token) {
    if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (this.now() >= session.expiresAt) { this.sessions.delete(token); return false; }
    return true;
  }

  /** Sign every paired computer out: the shared game was turned off. */
  endSessions() {
    this.sessions.clear();
  }

  /** How many paired computers are still signed in (for status; never the tokens). */
  sessionCount() {
    this.prune();
    return this.sessions.size;
  }

  prune() {
    const now = this.now();
    for (const [ip, record] of this.attempts) if (now - record.since > this.windowMs) this.attempts.delete(ip);
    for (const [ip, times] of this.pairings) {
      const recent = times.filter((at) => now - at <= this.windowMs);
      if (recent.length) this.pairings.set(ip, recent);
      else this.pairings.delete(ip);
    }
    for (const [token, session] of this.sessions) if (now >= session.expiresAt) this.sessions.delete(token);
  }
}

/**
 * Answer POST /api/pair for `pairing`: count the attempt, take a small JSON body only from the listener's own
 * address (`origin`), and set a session cookie when the code in it is right. `json` answers JSON, and `headers` go
 * on the answer that sets the cookie.
 */
export async function answerPair(pairing, request, response, { origin, json, headers = {} }) {
  const ip = request.socket.remoteAddress || "unknown";
  // Counted before anything is read, so parallel guesses cannot all slip past the limit.
  if (!pairing.allow(ip)) return json(response, 429, { error: "Too many attempts. Wait ten minutes and try again." });
  if (request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json"))
    return json(response, 403, { error: "Pair with the shared game at its own address." });
  let input = "";
  try {
    for await (const chunk of request) {
      input += chunk;
      if (input.length > 256) return json(response, 413, { error: "Invalid pairing request" });
    }
  } catch { return response.destroy(); } // The client hung up mid-body; there is no one to answer.
  let code = "";
  try { code = String(JSON.parse(input).code || ""); } catch { /* handled below */ }
  const sessionToken = pairing.pair(ip, code);
  if (!sessionToken) return json(response, 401, { error: "That pairing code did not match." });
  response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Set-Cookie": `goblin_horde_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` });
  return response.end(JSON.stringify({ paired: true }));
}

/** The session token from a Cookie header, or "". */
export function sessionCookie(header) {
  return String(header || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith("goblin_horde_session="))?.split("=")[1] || "";
}
