/**
 * Phone access over Wi-Fi: off until the person turns it on.
 *
 * The viewer always listens on 127.0.0.1. Only when phone access is on (phone.json in the state
 * folder says so) does it also listen on one private Wi-Fi address, where a paired phone can read
 * the chats, reply to Codex, and approve Codex requests. Turning it off closes that listener and
 * signs every phone out; "forget phones" writes a new pairing code and signs them out too.
 *
 * LAN_IP still picks the address by hand for development, but only while phone access is on.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { PAIRING_CODE, newPairingCode } from "./pairing.mjs";

export const PHONE_FILE = "phone.json";
export const CODE_FILE = "pairing-code.txt";

export function isPrivateIPv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Adapters that are not the Wi-Fi or wired network a phone sits on: VPNs (which Windows often calls
// "Ethernet 2"), virtual switches, and tunnels. A VPN adapter is also told apart by its MAC: TAP
// drivers use 00:FF:…, and WireGuard-style tunnels have none.
const NOT_LOCAL_NETWORK = /virtual|vpn|vethernet|hyper-v|vmware|virtualbox|vbox|docker|wsl|\btap\b|tap-|\btun|wireguard|\bwg\d|tailscale|zerotier|nordlynx|openvpn|anyconnect|globalprotect|pangp|fortinet|forticlient|cisco|juniper|pulse|bluetooth|loopback|npcap/i;
const tunnelMac = (mac) => !mac || /^00:00:00:00:00:00$/.test(mac) || /^00:ff:/i.test(mac);

/** This computer's private IPv4 addresses a phone could reach: [{ name, ip }], Wi-Fi first. */
export function lanCandidates(interfaces = networkInterfaces()) {
  const entries = Object.entries(interfaces || {}).flatMap(([name, addresses]) => (addresses || [])
    .filter((address) => address.family === "IPv4" || address.family === 4)
    .filter((address) => !address.internal && isPrivateIPv4(address.address) && !NOT_LOCAL_NETWORK.test(name) && !tunnelMac(address.mac))
    .map((address) => ({ name, ip: address.address })));
  const wifi = entries.filter(({ name }) => /wi-?fi|wlan|wireless/i.test(name));
  const wired = entries.filter(({ name }) => /^ethernet(?: \d+)?$/i.test(name));
  return [...wifi, ...wired];
}

/** The saved choice: { enabled, address }. Anything unreadable means off. */
export function readPhoneSetting(stateDir) {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, PHONE_FILE), "utf8"));
    return { enabled: saved?.enabled === true, address: isPrivateIPv4(saved?.address) ? saved.address : "" };
  } catch { return { enabled: false, address: "" }; }
}

export function writePhoneSetting(stateDir, { enabled, address = "" }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, PHONE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ enabled: enabled === true, ...(isPrivateIPv4(address) ? { address } : {}) })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Where the phone listener should listen, if anywhere: { enabled, address, adapter, problem }.
 * Off (no address) unless the person turned phone access on; then LAN_IP, a saved address that
 * this computer still has, or the first Wi-Fi (else wired) adapter that is not a VPN or virtual one.
 */
export function lanAddress({ stateDir, env = process.env, interfaces = networkInterfaces() }) {
  const setting = readPhoneSetting(stateDir);
  if (!setting.enabled) return { enabled: false, address: "", adapter: "", problem: "", choices: [] };
  if (env.LAN_IP) {
    return isPrivateIPv4(env.LAN_IP)
      ? { enabled: true, address: env.LAN_IP, adapter: "LAN_IP", problem: "", choices: [{ name: "LAN_IP", ip: env.LAN_IP }] }
      : { enabled: true, address: "", adapter: "", problem: "LAN_IP must be a private IPv4 address (10.x, 172.16-31.x, or 192.168.x).", choices: [] };
  }
  const candidates = lanCandidates(interfaces);
  const saved = candidates.filter(({ ip }) => ip === setting.address);
  const choices = [...saved, ...candidates.filter(({ ip }) => ip !== setting.address)];
  return choices.length ? { enabled: true, address: choices[0].ip, adapter: choices[0].name, problem: "", choices }
    : { enabled: true, address: "", adapter: "", problem: "No private Wi-Fi or wired network was found. Connect to your home or office Wi-Fi, or set LAN_IP.", choices: [] };
}

/**
 * Why Windows says an adapter is no place for phone access, or "": a virtual adapter (most VPNs,
 * which Windows names "Ethernet 2" and the like) or a network Windows calls Public (a café or
 * hotel hotspot). Off Windows, or when Windows cannot tell, nothing is refused.
 */
export function windowsAdapterRefusal(adapter, { platform = process.platform, run = execFile } = {}) {
  if (platform !== "win32" || !adapter || adapter === "LAN_IP") return Promise.resolve("");
  return new Promise((resolve) => {
    // The adapter name travels in an environment variable, never inside the script text.
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$n = Get-NetAdapter -Name $env:GH_ADAPTER -ErrorAction Stop",
      "$p = Get-NetConnectionProfile -InterfaceAlias $env:GH_ADAPTER -ErrorAction SilentlyContinue | Select-Object -First 1",
      "\"$($p.NetworkCategory)|$($n.Virtual)|$($n.HardwareInterface)\""].join("; ")],
    { windowsHide: true, timeout: 8000, env: { ...process.env, GH_ADAPTER: adapter } },
    (error, stdout) => resolve(error ? "" : adapterRefusal(adapter, String(stdout || ""))));
  });
}

/** Read windowsAdapterRefusal's "Category|Virtual|HardwareInterface" line. */
export function adapterRefusal(adapter, line) {
  const [category, virtual, hardware] = String(line).trim().split("|");
  if (/^true$/i.test(virtual || "") || /^false$/i.test(hardware || ""))
    return `"${adapter}" is a virtual adapter (often a VPN), not your Wi-Fi.`;
  if (/^public$/i.test(category || ""))
    return `Windows marks the network on "${adapter}" as Public. On your own Wi-Fi, set it to Private in Windows Settings > Network & internet, then turn phone access on again.`;
  return "";
}

/** The saved pairing code, an Activity Lens one carried over, or a new one; always saved back. */
export function loadPairingCode(stateDir, { env = process.env } = {}) {
  const codeFile = join(stateDir, CODE_FILE);
  try {
    const saved = readFileSync(codeFile, "utf8").trim();
    if (PAIRING_CODE.test(saved)) return saved;
  } catch { /* Create a code below. */ }
  let code = "";
  try {
    if (!env.LOCALAPPDATA) throw new Error("No Activity Lens folder outside Windows.");
    const legacy = readFileSync(join(env.LOCALAPPDATA, "ActivityLens", CODE_FILE), "utf8").trim();
    if (PAIRING_CODE.test(legacy)) code = legacy;
  } catch { /* No old code to carry over. */ }
  return savePairingCode(stateDir, code || newPairingCode());
}

export function savePairingCode(stateDir, code) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, CODE_FILE), `${code}\n`, { mode: 0o600 });
  return code;
}

/**
 * Why a request may not use a route only this computer may use (turning phone access on, changing
 * Claude Code's settings, ...), or null when it may: it must come from 127.0.0.1, never a paired
 * phone, from the viewer's own page, with a JSON body (so a plain form on another site cannot post).
 */
export function localOnlyRefusal({ local, origin, headers = {} }) {
  if (!local) return { status: 403, error: "Only this computer can do that." };
  if (headers.origin !== origin || !String(headers["content-type"] || "").startsWith("application/json"))
    return { status: 403, error: "Open the viewer first." };
  return null;
}

/**
 * What GET /api/mobile answers: whether phone access is on, where it listens, and why not. It says
 * nothing about any agent, and the pairing code goes only to this computer, while phone access is on.
 */
export function mobileStatus({ local, state, code }) {
  return {
    local, enabled: state.enabled, available: state.listening, address: state.url, adapter: state.adapter, problem: state.problem,
    ...(local && state.listening ? { code } : {}),
  };
}

const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

/**
 * The answer POST /api/respond sends Codex for one pending request, from the page's body:
 * { result } to send, or { status, error } to refuse. Approvals take "accept" or "decline" from this
 * computer or a phone. Codex's questions are answered on this computer only: a phone is never sent
 * their words or options (see public-view.mjs), so an answer from it would be blind.
 */
export function requestAnswer(pending, data, { local = false } = {}) {
  if (pending?.method === "item/tool/requestUserInput") {
    if (!local) return { status: 409, error: "Answer Codex's questions on this computer. A phone is not sent them." };
    const answers = {};
    for (const question of pending.params?.questions || []) {
      const answer = String(data?.answers?.[question.id] || "").trim();
      if (!answer || answer.length > 2000) return { status: 400, error: "Answer every question before submitting." };
      answers[question.id] = { answers: [answer] };
    }
    return { result: { answers } };
  }
  if (APPROVALS.has(pending?.method)) {
    if (!["accept", "decline"].includes(data?.decision)) return { status: 400, error: "Choose approve or decline." };
    return { result: { decision: data.decision } };
  }
  return { status: 400, error: "This request type is not supported on the phone yet." };
}

/** The phone listener and its on/off switch; `handler` answers its requests like the local one's. */
export class PhoneAccess {
  constructor({ stateDir, port, pairing, handler = () => {}, env = process.env, interfaces = () => networkInterfaces(),
    serve = createServer, refuse = windowsAdapterRefusal, log = console } = {}) {
    Object.assign(this, { stateDir, port, pairing, handler, env, interfaces, serve, refuse, log });
    this.server = null;
    this.current = { enabled: false, address: "", adapter: "", problem: "" };
    this.listening = false;
    this.changing = Promise.resolve();
  }

  /** What the widget and the viewer show: { enabled, listening, address, url, adapter, problem }. */
  state() {
    const { enabled, address, adapter, problem } = this.current;
    return { enabled, listening: this.listening, address: this.listening ? address : "",
      url: this.listening ? `http://${address}:${this.port}` : "", adapter: this.listening ? adapter : "", problem };
  }

  /** The address the phone listener answers on, for the Host check; "" while it is off. */
  get host() { return this.listening ? this.current.address : ""; }

  /** Apply the saved choice: at startup, and after every change. One change at a time. */
  apply() {
    this.changing = this.changing.then(() => this.reconcile(), () => this.reconcile());
    return this.changing.then(() => this.state());
  }

  async reconcile() {
    const { choices, ...decided } = lanAddress({ stateDir: this.stateDir, env: this.env, interfaces: this.interfaces() });
    let wanted = decided;
    if (choices.length) {
      // The first adapter Windows does not refuse; when all are refused, say why the first one was.
      let usable = null;
      let refusal = "";
      for (const choice of choices) {
        const why = await this.refuse(choice.name);
        if (!why) { usable = choice; break; }
        refusal ||= why;
      }
      wanted = usable ? { ...decided, address: usable.ip, adapter: usable.name }
        : { ...decided, address: "", adapter: "", problem: `Phone access is on but not listening: ${refusal}` };
    }
    if (this.listening && this.current.address === wanted.address) { this.current = wanted; return; }
    await this.closeListener();
    this.current = wanted;
    if (!wanted.address) return;
    const server = this.serve(this.handler);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, wanted.address, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      this.current = { ...wanted, problem: `Could not listen on ${wanted.address}: ${error.message}` };
      return;
    }
    server.on("error", (error) => this.log.error?.(`Wi-Fi listener: ${error.message}`));
    this.server = server;
    this.listening = true;
    this.log.log?.(`Phone address: http://${wanted.address}:${this.port}`);
  }

  async closeListener() {
    const server = this.server;
    this.server = null;
    this.listening = false;
    if (!server) return;
    // Phones hold keep-alive connections; end them so nothing keeps answering after "off".
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  /** Turn phone access on or off and remember it. Off also signs every phone out. */
  async setEnabled(enabled, { address = "" } = {}) {
    if (typeof enabled !== "boolean") throw Object.assign(new Error("Say whether phone access is on."), { statusCode: 400 });
    if (address && !lanCandidates(this.interfaces()).some(({ ip }) => ip === address))
      throw Object.assign(new Error("That is not one of this computer's Wi-Fi or wired addresses."), { statusCode: 400 });
    const saved = readPhoneSetting(this.stateDir);
    writePhoneSetting(this.stateDir, { enabled, address: address || saved.address });
    if (!enabled) this.pairing?.endSessions();
    return this.apply();
  }

  /** A new pairing code; every phone paired with the old one must pair again. */
  resetPairing() {
    const code = savePairingCode(this.stateDir, newPairingCode());
    this.pairing?.reset(code);
    return this.state();
  }

  close() { return this.closeListener(); }
}
