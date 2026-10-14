import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing, PAIRING_CODE, sessionCookie } from "../lib/pairing.mjs";
import {
  PhoneAccess, adapterRefusal, isPrivateIPv4, lanAddress, lanCandidates, loadPairingCode, localOnlyRefusal, readPhoneSetting,
  writePhoneSetting,
} from "../lib/phone.mjs";

const withDir = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "goblin-phone-"));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const nic = (address, mac = "a4:5e:60:11:22:33") => ({ family: "IPv4", internal: false, address, mac });
// A laptop on home Wi-Fi with a VPN ("Ethernet 2", TAP driver), a WireGuard tunnel, and WSL's switch.
const interfaces = {
  "Ethernet 2": [nic("10.8.0.6", "00:ff:12:34:56:78")],
  "Ethernet 3": [nic("10.9.0.2", "00:00:00:00:00:00")],
  "vEthernet (WSL)": [nic("172.20.0.1")],
  "Wi-Fi": [nic("192.168.1.20")],
  Ethernet: [nic("192.168.1.21")],
  Tailscale: [nic("100.100.1.1")],
  "Loopback Pseudo-Interface 1": [{ family: "IPv4", internal: true, address: "127.0.0.1", mac: "00:00:00:00:00:00" }],
};

test("private IPv4 means 10/8, 172.16/12, and 192.168/16 only", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) assert.equal(isPrivateIPv4(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "127.0.0.1", "192.168.1", "192.168.1.256", "0x0a.0.0.1", ""]) assert.equal(isPrivateIPv4(ip), false, ip);
});

test("by default no address is chosen, whatever the network or LAN_IP says", withDir((dir) => {
  assert.deepEqual(readPhoneSetting(dir), { enabled: false, address: "" });
  const decided = lanAddress({ stateDir: dir, env: { LAN_IP: "192.168.1.20" }, interfaces });
  assert.equal(decided.enabled, false);
  assert.equal(decided.address, "");
  // An unreadable or tampered setting is off too.
  writeFileSync(join(dir, "phone.json"), '{"enabled":"yes"}');
  assert.equal(lanAddress({ stateDir: dir, env: {}, interfaces }).address, "");
}));

test("once turned on, Wi-Fi is chosen before wired, and VPN or virtual adapters never are", withDir((dir) => {
  assert.deepEqual(lanCandidates(interfaces).map(({ name }) => name), ["Wi-Fi", "Ethernet"]);
  writePhoneSetting(dir, { enabled: true });
  assert.deepEqual(lanAddress({ stateDir: dir, env: {}, interfaces }), { enabled: true, address: "192.168.1.20", adapter: "Wi-Fi", problem: "",
    choices: [{ name: "Wi-Fi", ip: "192.168.1.20" }, { name: "Ethernet", ip: "192.168.1.21" }] });
  // Only VPNs: nothing is chosen, and the person is told why.
  const vpnOnly = { "Ethernet 2": interfaces["Ethernet 2"], "Ethernet 3": interfaces["Ethernet 3"] };
  const none = lanAddress({ stateDir: dir, env: {}, interfaces: vpnOnly });
  assert.equal(none.address, "");
  assert.match(none.problem, /No private Wi-Fi/);
  // A saved address the computer still has wins; LAN_IP overrides it for development; a bad LAN_IP is refused.
  writePhoneSetting(dir, { enabled: true, address: "192.168.1.21" });
  assert.equal(lanAddress({ stateDir: dir, env: {}, interfaces }).address, "192.168.1.21");
  assert.equal(lanAddress({ stateDir: dir, env: { LAN_IP: "10.1.2.3" }, interfaces }).address, "10.1.2.3");
  const bad = lanAddress({ stateDir: dir, env: { LAN_IP: "8.8.8.8" }, interfaces });
  assert.equal(bad.address, "");
  assert.match(bad.problem, /LAN_IP/);
}));

test("Windows' word on an adapter: virtual adapters and Public networks are refused", () => {
  assert.equal(adapterRefusal("Wi-Fi", "Private|False|True"), "");
  assert.equal(adapterRefusal("Wi-Fi", "DomainAuthenticated|False|True\r\n"), "");
  assert.match(adapterRefusal("Ethernet 2", "Private|True|False"), /virtual adapter/);
  assert.match(adapterRefusal("Wi-Fi", "Public|False|True"), /Public/);
  assert.equal(adapterRefusal("Wi-Fi", ""), "", "when Windows cannot tell, nothing is refused");
});

test("only this computer's own page may use local routes such as /api/phone", () => {
  const origin = "http://127.0.0.1:5000";
  const json = { origin, "content-type": "application/json" };
  assert.deepEqual(localOnlyRefusal({ local: false, origin, headers: json }), { status: 403, error: "Only this computer can do that." });
  assert.equal(localOnlyRefusal({ local: true, origin, headers: { ...json, origin: "http://evil.example" } }).status, 403);
  assert.equal(localOnlyRefusal({ local: true, origin, headers: { origin, "content-type": "text/plain" } }).status, 403);
  assert.equal(localOnlyRefusal({ local: true, origin, headers: json }), null);
});

class FakeServer extends EventEmitter {
  constructor(log) { super(); this.log = log; }
  listen(port, address, done) { this.log.push(["listen", port, address]); this.address = address; setImmediate(done); }
  closeAllConnections() { this.log.push(["drop", this.address]); }
  close(done) { this.log.push(["close", this.address]); setImmediate(done); }
}

function phoneAccess(dir, { refuse = async () => "", env = {} } = {}) {
  const log = [];
  const pairing = new Pairing({ code: loadPairingCode(dir, { env: {} }) });
  const access = new PhoneAccess({ stateDir: dir, port: 5000, pairing, env, interfaces: () => interfaces, refuse,
    serve: () => new FakeServer(log), log: {} });
  return { access, log, pairing };
}

test("a default start has no Wi-Fi listener", withDir(async (dir) => {
  const { access, log } = phoneAccess(dir, { env: { LAN_IP: "192.168.1.20" } });
  const state = await access.apply();
  assert.deepEqual(log, []);
  assert.equal(state.enabled, false);
  assert.equal(state.listening, false);
  assert.equal(state.url, "");
  assert.equal(access.host, "");
}));

test("turning phone access on listens on the Wi-Fi address; off closes it and signs phones out", withDir(async (dir) => {
  const { access, log, pairing } = phoneAccess(dir);
  const on = await access.setEnabled(true);
  assert.deepEqual(on, { enabled: true, listening: true, address: "192.168.1.20", url: "http://192.168.1.20:5000", adapter: "Wi-Fi", problem: "" });
  assert.deepEqual(readPhoneSetting(dir), { enabled: true, address: "" });
  assert.equal(access.host, "192.168.1.20");
  const token = pairing.pair("192.168.1.50", pairing.code);
  assert.equal(pairing.hasSession(token), true);
  const off = await access.setEnabled(false);
  assert.equal(off.listening, false);
  assert.equal(off.enabled, false);
  assert.deepEqual(log, [["listen", 5000, "192.168.1.20"], ["drop", "192.168.1.20"], ["close", "192.168.1.20"]]);
  assert.equal(pairing.hasSession(token), false, "turning off signs every phone out");
  assert.equal(readPhoneSetting(dir).enabled, false);
  // The choice survives a restart: a new server with the same state folder starts listening again.
  await access.setEnabled(true);
  const restarted = phoneAccess(dir);
  assert.equal((await restarted.access.apply()).listening, true);
  await assert.rejects(access.setEnabled("yes"), /Say whether/);
  await assert.rejects(access.setEnabled(true, { address: "10.8.0.6" }), /not one of this computer's/);
}));

test("an adapter Windows refuses is skipped; when all are refused phone access stays on but silent", withDir(async (dir) => {
  const refused = phoneAccess(dir, { refuse: async (name) => (name === "Wi-Fi" ? "\"Wi-Fi\" is on a Public network." : "") });
  assert.equal((await refused.access.setEnabled(true)).address, "192.168.1.21");
  const none = phoneAccess(dir, { refuse: async () => "Windows marks the network as Public." });
  const state = await none.access.apply();
  assert.equal(state.listening, false);
  assert.equal(state.enabled, true);
  assert.match(state.problem, /not listening: Windows marks the network as Public/);
  assert.deepEqual(none.log, []);
}));

test("a new pairing code is saved, and a phone paired with the old one is signed out", withDir(async (dir) => {
  const { access, pairing } = phoneAccess(dir);
  const before = readFileSync(join(dir, "pairing-code.txt"), "utf8").trim();
  assert.match(before, PAIRING_CODE);
  const cookie = `theme=dark; goblin_horde_session=${pairing.pair("192.168.1.50", before)}`;
  assert.equal(pairing.hasSession(sessionCookie(cookie)), true);
  access.resetPairing();
  const after = readFileSync(join(dir, "pairing-code.txt"), "utf8").trim();
  assert.match(after, PAIRING_CODE);
  assert.notEqual(after, before);
  assert.equal(pairing.code, after);
  assert.equal(pairing.hasSession(sessionCookie(cookie)), false, "the old session cookie no longer works");
  assert.equal(pairing.pair("192.168.1.50", before), "", "the old code no longer pairs");
  assert.match(pairing.pair("192.168.1.50", after), /^[a-f0-9]{64}$/);
  assert.equal(loadPairingCode(dir, { env: {} }), after, "the new code survives a restart");
}));
