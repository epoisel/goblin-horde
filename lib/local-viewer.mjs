/**
 * One request to a viewer on this computer, for the manager and for the saved game's lock.
 *
 * Every request has one deadline for the whole exchange. A viewer that takes the connection and says nothing,
 * that sends half an answer, or that sends its answer a byte at a time is given up on when the deadline comes,
 * whatever it sent meanwhile, and one that hangs up early is given up on at once. The promise always settles
 * and never rejects.
 */
import { request as httpRequest } from "node:http";

const ANSWER_LIMIT = 200_000;

/**
 * @typedef {{ status: number, text: string } | { status: 0, refused: boolean }} LocalAnswer
 *   A whole answer, or `status` 0 when none came in time. `refused` says nothing listens on the port.
 */

/**
 * Ask the viewer on 127.0.0.1 at `port` for `path`. A `body` is sent as JSON, with the viewer's own Origin, as
 * its local routes require.
 * @param {number} port @param {string} path @param {{ method?: string, body?: object, timeoutMs?: number }} [options]
 * @returns {Promise<LocalAnswer>}
 */
export function askLocal(port, path, { method = "GET", body, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const origin = `http://127.0.0.1:${port}`;
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(answer);
      request.destroy();
    };
    const none = (error) => settle({ status: 0, refused: error?.code === "ECONNREFUSED" });
    const request = httpRequest({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: { Host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Origin: origin }) },
    }, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { if (received.length < ANSWER_LIMIT) received += chunk; });
      response.on("end", () => settle({ status: response.statusCode, text: received }));
      response.on("error", none);
    });
    // The one deadline. Nothing the viewer sends moves or clears it, and it settles the promise whatever state the answer is in.
    const deadline = setTimeout(none, timeoutMs);
    request.on("error", none);
    // A connection that ends before the answer did ends the wait at once. That is the only word there is of a
    // viewer that answers 101: Node closes such a connection and never hands the answer over.
    request.on("close", none);
    request.end(text);
  });
}

/** The JSON a whole answer holds, or null when it is not JSON. */
export function answerJson(answer) {
  try { return answer.status ? JSON.parse(answer.text) : null; } catch { return null; }
}
