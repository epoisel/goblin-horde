import test from "node:test";
import assert from "node:assert/strict";
import { PAIRING_CODE, Pairing, newPairingCode, sessionCookie } from "../lib/pairing.mjs";

const clock = (start = 1_000_000) => {
  const time = { now: start };
  return { time, now: () => time.now };
};

test("attempts are counted before the code is checked, so parallel guesses cannot pass the limit", () => {
  const { now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now });
  // Five requests arrive together; none has been checked yet.
  const allowed = Array.from({ length: 8 }, () => pairing.allow("10.0.0.9"));
  assert.deepEqual(allowed, [true, true, true, true, true, false, false, false]);
  assert.equal(pairing.allow("10.0.0.10"), true, "another address has its own limit");
});

test("the right code earns a session and clears the address's attempts; a wrong one earns nothing", () => {
  const { now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now });
  assert.equal(pairing.allow("ip"), true);
  assert.equal(pairing.pair("ip", "ABCDEFGX"), "");
  assert.equal(pairing.pair("ip", "short"), "");
  assert.equal(pairing.pair("ip", undefined), "");
  for (let index = 0; index < 4; index++) pairing.allow("ip");
  const token = pairing.pair("ip", " abcd efgh ");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(pairing.attempts.has("ip"), false);
  assert.equal(pairing.allow("ip"), true, "a paired phone starts with a fresh count");
  assert.equal(pairing.hasSession(token), true);
  assert.equal(pairing.hasSession("f".repeat(64)), false);
  assert.equal(pairing.hasSession("not-hex"), false);
  assert.equal(new Pairing({ code: "", now }).pair("ip", ""), "", "an empty code never pairs");
});

test("old attempt records and expired sessions are pruned as requests arrive", () => {
  const { time, now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now, windowMs: 1000, sessionMs: 5000 });
  for (let index = 0; index < 5; index++) pairing.allow("a");
  assert.equal(pairing.allow("a"), false);
  const token = pairing.pair("b", "ABCDEFGH");
  time.now += 1001;
  assert.equal(pairing.allow("a"), true, "the window passed, so the address may try again");
  assert.equal(pairing.attempts.get("a").count, 1);
  time.now += 5000;
  pairing.allow("c");
  assert.equal(pairing.sessions.has(token), false);
  assert.equal(pairing.hasSession(token), false);
});

test("a reset sets a new code and signs every phone out; endSessions only signs them out", () => {
  const { now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now });
  const first = pairing.pair("ip", "ABCDEFGH");
  pairing.endSessions();
  assert.equal(pairing.hasSession(first), false);
  const second = pairing.pair("ip", "ABCDEFGH");
  for (let index = 0; index < 5; index++) pairing.allow("other");
  pairing.reset("JKLMNPQR");
  assert.equal(pairing.hasSession(second), false);
  assert.equal(pairing.pair("ip", "ABCDEFGH"), "");
  assert.equal(pairing.allow("other"), true, "attempt counts start over with the new code");
  assert.match(newPairingCode(), PAIRING_CODE);
  assert.equal(newPairingCode(() => Buffer.from([0, 1, 2, 3, 4, 5, 6, 31])), "ABCDEFG9");
});

/** One request to pair, as answerPair makes it: counted first, then checked. */
const tryPair = (pairing, ip, code = "ABCDEFGH") => (pairing.allow(ip) ? pairing.pair(ip, code) : "");

test("live sessions are capped at 32, and the oldest makes room for the newest", () => {
  const { now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now });
  const tokens = Array.from({ length: 40 }, (_, index) => tryPair(pairing, `10.0.0.${index}`));
  assert.ok(tokens.every((token) => /^[a-f0-9]{64}$/.test(token)), "each of 40 phones pairs");
  assert.equal(pairing.sessionCount(), 32);
  assert.deepEqual(tokens.map((token) => pairing.hasSession(token)), [...Array(8).fill(false), ...Array(32).fill(true)], "the first eight were signed out, oldest first");

  const small = new Pairing({ code: "ABCDEFGH", now, maxSessions: 2 });
  const [first, second, third] = ["a", "b", "c"].map((ip) => tryPair(small, ip));
  assert.deepEqual([small.hasSession(first), small.hasSession(second), small.hasSession(third), small.sessionCount()], [false, true, true, 2]);
});

test("with one session per computer, the code again from a computer that is signed in answers the session it has, and counts for nothing", () => {
  const { time, now } = clock();
  const shared = new Pairing({ code: "ABCDEFGH", now, onePerPeer: true });
  const laptop = tryPair(shared, "100.100.1.1");
  const desk = tryPair(shared, "100.100.1.2");
  const laptopAgain = tryPair(shared, "100.100.1.1");
  assert.equal(laptopAgain, laptop, "a second program on the laptop is answered the laptop's own session, not a new one");
  assert.deepEqual([shared.hasSession(laptop), shared.hasSession(desk), shared.sessionCount()], [true, true, 2], "so the first program's session still works");

  // The review's case was seven join checks beside one display. Here it is fifty, and the display stays signed in.
  for (let check = 0; check < 50; check += 1) assert.equal(tryPair(shared, "100.100.1.1"), laptop, `check ${check + 1}`);
  assert.equal(shared.pairings.get("100.100.1.1").length, 1, "one pairing is counted against the laptop's eight in ten minutes, however often it gave the code");
  assert.equal(shared.attempts.has("100.100.1.1"), false, "and none of them is a wrong try");
  assert.equal(shared.sessionCount(), 2);

  // A wrong code from a computer that is signed in earns nothing, and still counts.
  assert.equal(tryPair(shared, "100.100.1.1", "ABCDEFGX"), "");
  assert.equal(shared.attempts.get("100.100.1.1").count, 1);
  for (let guess = 0; guess < 4; guess += 1) tryPair(shared, "100.100.1.1", "AAAAAAAA");
  assert.equal(shared.allow("100.100.1.1"), false, "five wrong codes close pairing to it, signed in or not");
  assert.equal(shared.hasSession(laptop), true, "while the session it has goes on");

  // Signed out, or with its session run out, the next right code is a new session, and a pairing that counts.
  time.now += 10 * 60_000 + 1;
  shared.endSessions();
  const second = tryPair(shared, "100.100.1.1");
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(second, laptop);
  assert.deepEqual([shared.hasSession(laptop), shared.pairings.get("100.100.1.1").length], [false, 1]);
  time.now += 24 * 60 * 60_000;
  const third = tryPair(shared, "100.100.1.1");
  assert.ok(/^[a-f0-9]{64}$/.test(third) && third !== second, "a session that ran out is not answered again");
  assert.equal(shared.sessionCount(), 1, "one session for each computer at most");
  // A code is checked a moment after its request was counted, once the body has come. A session that ran out in between is not answered either.
  assert.equal(shared.allow("100.100.1.1"), true);
  time.now += 24 * 60 * 60_000;
  const fourth = shared.pair("100.100.1.1", "ABCDEFGH");
  assert.ok(/^[a-f0-9]{64}$/.test(fourth) && fourth !== third && shared.hasSession(fourth) && !shared.hasSession(third), "the answer is a session that works");

  // Eight new sessions in ten minutes are an address's limit. Signed in, it is still answered the one it has.
  const busy = new Pairing({ code: "ABCDEFGH", now, onePerPeer: true });
  for (let turn = 0; turn < 8; turn += 1) {
    assert.match(tryPair(busy, "100.100.1.3"), /^[a-f0-9]{64}$/, `pairing ${turn + 1}`);
    if (turn < 7) busy.endSessions();
  }
  const [last] = busy.sessions.keys();
  assert.equal(tryPair(busy, "100.100.1.3"), last, "at its limit and signed in: its own session");
  busy.endSessions();
  assert.equal(tryPair(busy, "100.100.1.3"), "", "at its limit and signed out: nothing more until the ten minutes pass");

  const phones = new Pairing({ code: "ABCDEFGH", now });
  const [one, two] = [tryPair(phones, "192.168.1.30"), tryPair(phones, "192.168.1.30")];
  assert.notEqual(one, two);
  assert.deepEqual([phones.hasSession(one), phones.hasSession(two)], [true, true], "phones keep a session for each browser");
});

test("the right code over and over from one address makes a bounded number of sessions, not thousands", () => {
  const { time, now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now });
  const earned = Array.from({ length: 5000 }, () => tryPair(pairing, "100.100.1.9")).filter(Boolean);
  assert.equal(earned.length, 8, "eight pairings in ten minutes, and then the address waits");
  assert.equal(pairing.sessionCount(), 8);
  assert.equal(pairing.allow("100.100.1.9"), false, "the next try is not even checked");
  assert.equal(pairing.pair("100.100.1.9", "ABCDEFGH"), "", "and the code alone earns nothing more in that time");
  assert.match(tryPair(pairing, "100.100.1.10"), /^[a-f0-9]{64}$/, "another address is not held back");
  time.now += 10 * 60_000 + 1;
  assert.match(tryPair(pairing, "100.100.1.9"), /^[a-f0-9]{64}$/, "after ten minutes it may pair again");

  const exact = new Pairing({ code: "ABCDEFGH", now });
  for (let turn = 0; turn < 8; turn += 1) assert.match(tryPair(exact, "100.100.1.9"), /^[a-f0-9]{64}$/, `pairing ${turn + 1}`);
  assert.equal(exact.allow("100.100.1.9"), false, "the ninth request is turned away before its body is read, with no wrong guess behind it");
  assert.equal(exact.attempts.has("100.100.1.9"), false, "and it is not counted as a wrong guess");

  const shared = new Pairing({ code: "ABCDEFGH", now, onePerPeer: true });
  for (let turn = 0; turn < 5000; turn += 1) tryPair(shared, "100.100.1.9");
  assert.equal(shared.sessionCount(), 1);

  const many = new Pairing({ code: "ABCDEFGH", now });
  for (let peer = 0; peer < 300; peer += 1) for (let turn = 0; turn < 20; turn += 1) tryPair(many, `100.100.${peer >> 8}.${peer & 255}`);
  assert.equal(many.sessionCount(), 32, "however many addresses pair, at most 32 sessions live");
  many.reset("JKLMNPQR");
  assert.match(tryPair(many, "100.100.0.0", "JKLMNPQR"), /^[a-f0-9]{64}$/, "a new code starts every count over");
});

test("the attempt table is bounded, and a full table refuses new addresses and forgives nobody", () => {
  const { time, now } = clock();
  const pairing = new Pairing({ code: "ABCDEFGH", now, maxPeers: 3 });
  for (let guess = 0; guess < 5; guess += 1) assert.equal(pairing.allow("offender"), true);
  assert.equal(pairing.allow("offender"), false);
  assert.equal(pairing.allow("second"), true);
  assert.equal(pairing.allow("third"), true);
  for (const stranger of ["fourth", "fifth", "sixth"]) assert.equal(pairing.allow(stranger), false, `${stranger} finds the table full`);
  assert.equal(pairing.allow("offender"), false, "the address that used up its guesses was not forgotten to make room");
  assert.equal(pairing.allow("second"), true, "an address already in the table keeps its remaining tries");
  assert.equal(pairing.attempts.size, 3);
  assert.equal(pairing.pair("fourth", "ABCDEFGH"), "", "an address the table refused cannot pair, even with the right code");

  time.now += 10 * 60_000 + 1;
  assert.equal(pairing.allow("fourth"), true, "when the ten minutes pass there is room again");

  const big = new Pairing({ code: "ABCDEFGH", now });
  const allowed = Array.from({ length: 5000 }, (_, index) => big.allow(`peer-${index}`)).filter(Boolean).length;
  assert.equal(allowed, 1024, "1,024 addresses at most are tracked at once");
  assert.equal(big.attempts.size, 1024);
});

test("the session token is read from the cookie header", () => {
  assert.equal(sessionCookie("theme=dark; goblin_horde_session=abc123; other=1"), "abc123");
  assert.equal(sessionCookie(undefined), "");
});
