import test from "node:test";
import assert from "node:assert/strict";
import { Pairing, sessionCookie } from "../lib/pairing.mjs";

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

test("the session token is read from the cookie header", () => {
  assert.equal(sessionCookie("theme=dark; goblin_horde_session=abc123; other=1"), "abc123");
  assert.equal(sessionCookie(undefined), "");
});
