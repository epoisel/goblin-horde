/**
 * What tests of the shared game need from the viewer without starting one: its `json` and `readBody`, the
 * paths its route code names, a plain HTTP client that sets any header, and an isolated server.mjs process.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../..", import.meta.url));
const read = (file) => readFileSync(join(SOURCE, file), "utf8");

// server.mjs's own json and readBody, copied here because importing server.mjs starts the viewer.
const BODY_LIMIT = 12_000;
const tooLarge = () => Object.assign(new Error("Request is too large."), { statusCode: 413 });
export function json(response, status, data) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
export async function readBody(request) {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) {
    request.resume();
    throw tooLarge();
  }
  const input = await new Promise((resolve, reject) => {
    let text = "";
    let overflow = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (overflow) return;
      text += chunk;
      if (text.length > BODY_LIMIT) { overflow = true; text = ""; }
    });
    request.on("end", () => (overflow ? reject(tooLarge()) : resolve(text)));
    request.on("error", reject);
  });
  try { return JSON.parse(input); } catch { throw Object.assign(new Error("Invalid request."), { statusCode: 400 }); }
}

// Routes an older viewer had: the agent monitor's, the browser viewer's pages, and phone access. None may answer.
const OLDER_ROUTES = ["/", "/index.html", "/app/", "/app/app.js", "/pair.html", "/pair.js", "/goblin_art.json", "/api/scene", "/api/threads", "/api/tasks",
  "/api/transcript", "/api/agent", "/api/message", "/api/reply", "/api/respond", "/api/phone", "/api/phone/reset", "/api/mobile", "/api/config",
  "/api/capabilities", "/api/diagnostics", "/api/connect-claude", "/api/autostart", "/api/app/open"];

/**
 * Every path the viewer's route code names, read from its source (the quoted paths in server.mjs and the pets
 * routes it mounts), and every route an older viewer had.
 * @returns {string[]}
 */
export function viewerPaths() {
  const quoted = ["server.mjs", "lib/pets-routes.mjs"].map(read).flatMap((text) => text.match(/"\/[A-Za-z_./-]*"/g) || []).map((literal) => literal.slice(1, -1));
  return [...new Set([...quoted, ...OLDER_ROUTES])].sort();
}

/**
 * One HTTP request with exactly the headers given, Host included, which fetch does not allow.
 * @returns {Promise<{ status: number, body: any, text: string, cookie: string }>} `body` is the parsed JSON or null.
 */
export function ask(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const request = httpRequest({ host: "127.0.0.1", port, method, path, agent: false, headers: { ...(text ? { "Content-Length": Buffer.byteLength(text) } : {}), ...headers } }, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { received += chunk; });
      response.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(received); } catch { /* Not JSON. */ }
        const cookie = (response.headers["set-cookie"] || []).map((item) => item.split(";")[0]).join("; ");
        resolve({ status: response.statusCode, body: parsed, text: received, cookie });
      });
    });
    request.on("error", reject);
    request.end(text);
  });
}

export async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Ask `read()` until `done(value)`, for at most `ms`. Throws `problem` when it never is. */
export async function until(read, done, problem, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = await read().catch(() => null);
    if (value && done(value)) return value;
  }
  throw new Error(problem);
}

/** The environment of an isolated viewer under `root`: every folder inside `root`, and `extra` on top. */
export function viewerEnv(root, { port, stateDir, extra = {} }) {
  return { ...process.env, PORT: String(port), GOBLIN_HORDE_STATE_DIR: stateDir, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), ...extra };
}

/**
 * Start server.mjs with `env`, its output going to `logFile`. `stop()` ends it and waits for it to be gone.
 * @returns {{ child: import("node:child_process").ChildProcess, stop(): Promise<void> }}
 */
export function startViewer(env, logFile) {
  const log = openSync(logFile, "a");
  const child = spawn(process.execPath, [join(SOURCE, "server.mjs")], { env, stdio: ["ignore", log, log], windowsHide: true });
  closeSync(log);
  return {
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    },
  };
}
