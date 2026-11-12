/**
 * What Goblin Horde asks of Tailscale: which addresses are tailnet addresses, which one is this computer's
 * own, and whether a peer is signed in to the same Tailscale account as this computer.
 *
 * The `tailscale` program is only ever read (`ip -4`, `status --json`, `whois --json <ip>`), without a shell
 * and with a short timeout. What it prints is never logged or sent anywhere: a login is compared and dropped.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";
import { posix, win32 } from "node:path";

/** Whether `ip` is in 100.64.0.0/10, the range Tailscale gives IPv4 addresses from. */
export function isTailscaleIPv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** A socket's peer address for the range check: an IPv4 peer on a dual-stack socket reads as plain IPv4. */
export const plainAddress = (address) => String(address || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");

/** Whether `address` is a tailnet address: 100.64.0.0/10, or Tailscale's IPv6 range fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(address) {
  const ip = plainAddress(address);
  return isTailscaleIPv4(ip) || (isIPv6(ip) && /^fd7a:115c:a1e0:/i.test(ip));
}

/** Whether `address` is this computer talking to itself. */
export const isLoopback = (address) => ["127.0.0.1", "::1"].includes(plainAddress(address));

export const LOOPBACK_ENV = "GOBLIN_SHARED_LOOPBACK";

/**
 * The port of a loopback stand-in for the tailnet, or 0 when there is none. With GOBLIN_SHARED_LOOPBACK=<port> a
 * host listens on 127.0.0.1 at that port for loopback callers only, a display may join a host at 127.0.0.1, and
 * Tailscale is asked nothing. Tests and the clean-install check use it. It can only ever narrow the shared game
 * to this computer, which 127.0.0.1 already reaches.
 */
export function loopbackStandIn(env = process.env) {
  const port = Number(env?.[LOOPBACK_ENV]);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
}

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
// Where Tailscale installs its program when it is not on PATH.
const PLACES = {
  win32: (env) => [win32.join(env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")],
  darwin: () => ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"],
  linux: () => ["/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale"],
};

/** The `tailscale` program on this computer, from PATH or its usual install folder, or "" when there is none. */
export function findTailscale({ env = process.env, platform = process.platform, exists = isFile } = {}) {
  const [path, program] = platform === "win32" ? [win32, "tailscale.exe"] : [posix, "tailscale"];
  const onPath = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)
    .map((folder) => path.join(folder.replace(/^"|"$/g, ""), program));
  return [...onPath, ...(PLACES[platform]?.(env) || [])].find((candidate) => exists(candidate)) || "";
}

/**
 * Run the tailscale program and answer what it printed. It rejects when the program fails or takes longer than
 * four seconds, with words that hold neither its arguments nor its output.
 * @returns {Promise<string>}
 */
export function runTailscale(cli, args, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(new Error("The tailscale program did not answer.")) : resolve(String(stdout))));
  });
}

// A device signed in by a person. Tagged devices share the login "tagged-devices", which names nobody.
const person = (login) => {
  const name = String(login || "").trim().toLowerCase();
  return name && name !== "tagged-devices" ? name : "";
};
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Whether `name` is a lower-case DNS name, such as a MagicDNS name, and not a row of numbers. */
export const isDnsName = (name) => DNS_NAME.test(String(name)) && /[a-z]/.test(name);

/**
 * What `tailscale status --json` says about this computer: whether Tailscale is connected, the login it is
 * signed in with ("" for none or a tagged device), its MagicDNS names (the full name, then the short one), and
 * its Tailscale IPv4 addresses.
 * @returns {{ running: boolean, login: string, names: string[], addresses: string[] }}
 */
export function readStatus(text) {
  let status;
  try { status = JSON.parse(text); } catch { return { running: false, login: "", names: [], addresses: [] }; }
  const self = status?.Self || {};
  const dns = String(self.DNSName || "").replace(/\.$/, "").toLowerCase();
  return {
    running: status?.BackendState === "Running",
    login: Array.isArray(self.Tags) && self.Tags.length ? "" : person(status?.User?.[String(self.UserID)]?.LoginName),
    names: isDnsName(dns) ? [...new Set([dns, dns.split(".")[0]])].filter(isDnsName) : [],
    addresses: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => typeof ip === "string" && isTailscaleIPv4(ip)) : [],
  };
}

/** The login `tailscale whois --json <ip>` names for a peer, or "" for a tagged device or an unreadable answer. */
export function readWhois(text) {
  try {
    const answer = JSON.parse(text);
    return Array.isArray(answer?.Node?.Tags) && answer.Node.Tags.length ? "" : person(answer?.UserProfile?.LoginName);
  } catch { return ""; }
}

/**
 * The same-account check: `(ip) => Promise<boolean>`, true only when `tailscale whois` names for the peer the
 * login this computer itself is signed in with. A lookup that fails, a tagged device, and a computer whose own
 * login cannot be read all answer false. A verdict is kept for a minute and a failed lookup for ten seconds, for
 * at most `max` addresses, so a caller that polls every second costs one lookup a minute.
 */
export function createWhois({ cli, run = runTailscale, now = Date.now, ttlMs = 60_000, retryMs = 10_000, max = 64 }) {
  const verdicts = new Map();
  const pending = new Map();
  let own = null;

  async function ownLogin() {
    if (own && now() < own.until) return own.login;
    let login = "";
    try { login = readStatus(await run(cli, ["status", "--json"])).login; } catch { /* Refused below. */ }
    own = { login, until: now() + (login ? ttlMs : retryMs) };
    return login;
  }

  async function lookup(ip) {
    const mine = await ownLogin();
    if (!mine) return { same: false, keepMs: retryMs };
    try { return { same: readWhois(await run(cli, ["whois", "--json", ip])) === mine, keepMs: ttlMs }; }
    catch { return { same: false, keepMs: retryMs }; }
  }

  return function sameAccount(ip) {
    const saved = verdicts.get(ip);
    if (saved && now() < saved.until) return Promise.resolve(saved.same);
    if (!pending.has(ip)) {
      pending.set(ip, lookup(ip).then(({ same, keepMs }) => {
        verdicts.delete(ip);
        verdicts.set(ip, { same, until: now() + keepMs });
        while (verdicts.size > max) verdicts.delete(verdicts.keys().next().value);
        return same;
      }).finally(() => pending.delete(ip)));
    }
    return pending.get(ip);
  };
}

const nobody = () => ({ address: "", names: [] });
const adapterHas = (interfaces, ip) => Object.values(interfaces || {}).some((addresses) => (addresses || [])
  .some((address) => (address.family === "IPv4" || address.family === 4) && !address.internal && address.address === ip));

/**
 * This computer as its own tailscale program describes it: `{ address, names }`, its Tailscale IPv4 address and
 * its MagicDNS names. The address is "" unless the program says all of it: `tailscale ip -4` names the address,
 * `tailscale status --json` says Tailscale is connected and lists that address as this computer's, and an
 * adapter has it. Nothing else stands in for the program's word. An internet provider can hand out addresses
 * from the same range, and anyone can name an adapter, so without the program no adapter is taken for Tailscale's.
 * @returns {Promise<{ address: string, names: string[] }>}
 */
export async function tailscaleSelf({ interfaces = networkInterfaces(), cli = "", run = runTailscale } = {}) {
  if (!cli) return nobody();
  try {
    const named = (await run(cli, ["ip", "-4"])).split(/\r?\n/).map((line) => line.trim()).find(isTailscaleIPv4) || "";
    const status = readStatus(await run(cli, ["status", "--json"]));
    return named && status.running && status.addresses.includes(named) && adapterHas(interfaces, named) ? { address: named, names: status.names } : nobody();
  } catch { return nobody(); }
}

/** This computer's own Tailscale IPv4 address as `tailscaleSelf` finds it, or "" when it has none to listen on. */
export const ownTailscaleAddress = async (options) => (await tailscaleSelf(options)).address;
