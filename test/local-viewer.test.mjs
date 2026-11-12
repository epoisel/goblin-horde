/**
 * What the manager and the saved game's lock ask of a viewer on this computer, against raw sockets on 127.0.0.1
 * that answer the way a stuck or broken viewer does. Each request has one deadline, and its promise always settles.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { askLocal } from "../lib/local-viewer.mjs";
import { getLocalJson } from "../lib/manager.mjs";
import { viewerHolds } from "../lib/pets-lock.mjs";
import { freePort } from "./helpers/viewer.mjs";

const HEAD = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n";

/** A raw server that runs `reply(socket)` once a request arrives and then leaves the connection as it is. */
async function rawViewer(t, reply) {
  const sockets = new Set();
  const timers = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => reply(socket, (run, ms) => timers.add(setInterval(run, ms))));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return server.address().port;
}

// Each of these never finishes its answer. The first is the review's: a 200, and a body that stops in the middle.
const NEVER_WHOLE = [
  ["a 200 and half a body", (socket) => socket.write(`${HEAD}\r\n{"shared":`)],
  ["a 200 with a length it never reaches", (socket) => socket.write(`${HEAD}Content-Length: 4000\r\n\r\n{"shared":{"sessions":0}}`)],
  ["headers that never end", (socket) => socket.write(HEAD)],
  ["nothing at all", () => {}],
  ["a body sent a byte at a time, for ever", (socket, every) => { socket.write(`${HEAD}Transfer-Encoding: chunked\r\n\r\n`); every(() => socket.write("1\r\n \r\n"), 20); }],
  ["an early answer with nothing after it", (socket) => socket.write("HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\n")],
  ["a hang-up in the middle of the body", (socket) => socket.end(`${HEAD}Content-Length: 4000\r\n\r\n{"shared":`)],
  ["a hang-up with no answer", (socket) => socket.destroy()],
  // A viewer speaks HTTP and nothing else. One that changes protocol is not asked anything more.
  ["a 101 that keeps the connection", (socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")],
  ["a 101 and then other bytes", (socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n{\"shared\":{\"sessions\":0}}")],
];

test("a request to a viewer that never finishes its answer settles at its deadline, whatever the viewer sent meanwhile", async (t) => {
  for (const [what, reply] of NEVER_WHOLE) {
    const port = await rawViewer(t, reply);
    for (const [name, ask] of [
      ["askLocal", () => askLocal(port, "/api/shared", { timeoutMs: 250 }).then((answer) => answer.status)],
      ["a POST", () => askLocal(port, "/api/shared", { method: "POST", body: { enabled: false }, timeoutMs: 250 }).then((answer) => answer.status)],
      ["getLocalJson", () => getLocalJson(port, "/api/shared", 250).then((data) => (data === null ? 0 : "data"))],
    ]) {
      const started = Date.now();
      const outcome = await Promise.race([ask(), sleep(3000).then(() => "still waiting")]);
      assert.equal(outcome, 0, `${name}, ${what}`);
      assert.ok(Date.now() - started < 1500, `${name}, ${what}: settled after ${Date.now() - started} ms`);
    }
  }
  // A viewer that hangs up, or that changes protocol, is given up on at once, long before a deadline of 20 seconds.
  for (const [what, reply] of NEVER_WHOLE.filter(([name]) => /hang-up|101/.test(name))) {
    const port = await rawViewer(t, reply);
    const outcome = await Promise.race([askLocal(port, "/api/shared", { timeoutMs: 20_000 }).then((answer) => answer.status), sleep(3000).then(() => "still waiting")]);
    assert.equal(outcome, 0, `${what}, with a long deadline`);
  }
});

test("a whole answer is read, a refused connection is told apart, and an answer that is not JSON is no data", async (t) => {
  const whole = await rawViewer(t, (socket) => socket.end(`${HEAD}Content-Length: 25\r\n\r\n{"shared":{"sessions":0}}`));
  assert.deepEqual(await askLocal(whole, "/api/shared"), { status: 200, text: "{\"shared\":{\"sessions\":0}}" });
  assert.deepEqual(await getLocalJson(whole, "/api/shared"), { shared: { sessions: 0 } });
  const page = await rawViewer(t, (socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n<html>"));
  assert.equal(await getLocalJson(page, "/api/shared"), null);
  const missing = await rawViewer(t, (socket) => socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}"));
  assert.equal(await getLocalJson(missing, "/api/shared"), null, "only a 200 is data");
  assert.deepEqual(await askLocal(missing, "/api/shared"), { status: 404, text: "{}" });
  assert.deepEqual(await askLocal(await freePort(), "/api/health"), { status: 0, refused: true }, "nothing listens there");
  const silent = await rawViewer(t, () => {});
  assert.deepEqual(await askLocal(silent, "/api/health", { timeoutMs: 100 }), { status: 0, refused: false }, "something listens and says nothing");
});

test("a lock's viewer that never finishes its answer is not taken for gone, and the question still ends in time", async (t) => {
  for (const [what, reply] of NEVER_WHOLE) {
    const port = await rawViewer(t, reply);
    const started = Date.now();
    const outcome = await Promise.race([viewerHolds({ pid: 4242, port }, { timeoutMs: 250 }), sleep(3000).then(() => "still waiting")]);
    assert.equal(outcome, true, `${what}: only a definite no frees a lock`);
    assert.ok(Date.now() - started < 1500, `${what}: answered after ${Date.now() - started} ms`);
  }
  assert.equal(await viewerHolds({ pid: 4242, port: await freePort() }, { timeoutMs: 250 }), false, "nothing listens on the lock's port");
});
