/**
 * Phone pairing: a per-address attempt limit and the session tokens a correct code earns.
 *
 * An attempt is counted the moment a request arrives, before its body is read, so guesses sent in
 * parallel cannot all pass the limit while the first ones are still being read. Old attempt
 * records and expired sessions are pruned as new requests come in, so neither map grows forever.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export class Pairing {
  constructor({ code, now = () => Date.now(), maxAttempts = 5, windowMs = 10 * 60_000, sessionMs = 24 * 60 * 60_000 } = {}) {
    this.code = String(code || "");
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.sessionMs = sessionMs;
    this.attempts = new Map();
    this.sessions = new Map();
  }

  /** Count one attempt from `ip`; false when this address already used up its attempts in the window. */
  allow(ip) {
    this.prune();
    const record = this.attempts.get(ip) || { count: 0, since: this.now() };
    if (record.count >= this.maxAttempts) return false;
    record.count++;
    this.attempts.set(ip, record);
    return true;
  }

  /** A new session token when `supplied` is the code (its attempts are then forgotten), otherwise "". */
  pair(ip, supplied) {
    const given = Buffer.from(String(supplied ?? "").toUpperCase().replace(/\s/g, ""));
    const expected = Buffer.from(this.code);
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return "";
    this.attempts.delete(ip);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, this.now() + this.sessionMs);
    return token;
  }

  hasSession(token) {
    if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (this.now() >= expiresAt) { this.sessions.delete(token); return false; }
    return true;
  }

  prune() {
    const now = this.now();
    for (const [ip, record] of this.attempts) if (now - record.since > this.windowMs) this.attempts.delete(ip);
    for (const [token, expiresAt] of this.sessions) if (now >= expiresAt) this.sessions.delete(token);
  }
}

/** The session token from a Cookie header, or "". */
export function sessionCookie(header) {
  return String(header || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith("goblin_horde_session="))?.split("=")[1] || "";
}
