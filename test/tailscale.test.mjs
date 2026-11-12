/**
 * The Tailscale helpers on invented computers. No test runs the real tailscale program: `run` is a fake that
 * answers what `tailscale` would print, with invented logins and addresses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWhois, findTailscale, isTailscaleAddress, isTailscaleIPv4, ownTailscaleAddress, plainAddress, readStatus, readWhois, tailscaleSelf,
} from "../lib/tailscale.mjs";

const OWNER = "owner@example.com";
const nic = (address, extra = {}) => ({ family: "IPv4", internal: false, address, ...extra });
const status = ({ login = OWNER, state = "Running", dns = "servitor.tail1234.ts.net.", tags, ips = ["100.101.102.103", "fd7a:115c:a1e0::1"] } = {}) => JSON.stringify({
  BackendState: state, Self: { UserID: 42, DNSName: dns, TailscaleIPs: ips, ...(tags ? { Tags: tags } : {}) },
  User: { 42: { ID: 42, LoginName: login, DisplayName: "The Owner" } },
});
const whois = (login, tags) => JSON.stringify({ Node: { Name: "laptop.tail1234.ts.net.", ...(tags ? { Tags: tags } : {}) }, UserProfile: { ID: 7, LoginName: login } });

/** A fake tailscale program: `answers` maps "status" and each peer address to what it prints, or to an Error. */
function program(answers) {
  const calls = [];
  const run = async (cli, args) => {
    calls.push(args.join(" "));
    const answer = answers[args[0] === "whois" ? args.at(-1) : args[0]];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("no such peer");
    return typeof answer === "function" ? answer() : answer;
  };
  return { run, calls, count: (prefix) => calls.filter((call) => call.startsWith(prefix)).length };
}

test("only 100.64.0.0/10 and fd7a:115c:a1e0::/48 are tailnet addresses", () => {
  for (const ip of ["100.64.0.0", "100.64.0.1", "100.100.1.1", "100.127.255.255"]) assert.equal(isTailscaleIPv4(ip), true, ip);
  for (const ip of ["100.63.255.255", "100.128.0.0", "10.0.0.1", "192.168.1.20", "127.0.0.1", "100.64.0", "100.64.0.256", "0x64.64.0.1", "100.64.0.1.", " 100.64.0.1", ""])
    assert.equal(isTailscaleIPv4(ip), false, ip);
  for (const ip of ["100.100.1.1", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:626e:bd3d", "FD7A:115C:A1E0::9"])
    assert.equal(isTailscaleAddress(ip), true, ip);
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:192.168.1.5", "fd7a:115c:a1e1::1", "fd7a:115c::1", "fe80::1", "2001:db8::1", "fd7a:115c:a1e0:zz::1", "100.100.1.1, 10.0.0.1", undefined])
    assert.equal(isTailscaleAddress(ip), false, String(ip));
  assert.equal(plainAddress("::ffff:100.100.1.1"), "100.100.1.1");
  assert.equal(plainAddress("::ffff:fd7a:115c:a1e0::1"), "::ffff:fd7a:115c:a1e0::1", "only a dotted IPv4 is unwrapped");
});

test("the tailscale program is found on PATH or in its install folder, and nowhere else", () => {
  const onPath = "C:\\tools\\tailscale.exe";
  const installed = "C:\\Program Files\\Tailscale\\tailscale.exe";
  const find = (present, env = { PATH: "C:\\Windows;C:\\tools", ProgramFiles: "C:\\Program Files" }) =>
    findTailscale({ env, platform: "win32", exists: (path) => present.includes(path) });
  assert.equal(find([onPath, installed]), onPath);
  assert.equal(find([installed]), installed);
  assert.equal(find([]), "");
  assert.equal(findTailscale({ env: { PATH: "/usr/local/bin:/opt/bin" }, platform: "linux", exists: (path) => path === "/usr/sbin/tailscale" }), "/usr/sbin/tailscale");
});

test("status names this computer's login and MagicDNS names, and a tagged or signed-out computer has no login", () => {
  assert.deepEqual(readStatus(status()), { running: true, login: OWNER, names: ["servitor.tail1234.ts.net", "servitor"], addresses: ["100.101.102.103"] });
  assert.equal(readStatus(status({ login: "Owner@Example.COM " })).login, OWNER, "logins compare without case");
  assert.equal(readStatus(status({ login: "tagged-devices" })).login, "");
  assert.equal(readStatus(status({ tags: ["tag:server"] })).login, "");
  assert.deepEqual(readStatus(status({ state: "NeedsLogin", login: "", dns: "" })), { running: false, login: "", names: [], addresses: ["100.101.102.103"] });
  assert.deepEqual(readStatus(status({ dns: "evil host/../x." })).names, [], "a name that is not a DNS name is not a Host this computer answers to");
  assert.deepEqual(readStatus(status({ ips: ["fd7a:115c:a1e0::1", "192.168.1.20", "100.90.1.2", 7, "100.90.1.2 "] })).addresses, ["100.90.1.2"], "only its Tailscale IPv4 addresses");
  for (const ips of [null, "100.101.102.103", { 0: "100.101.102.103" }]) assert.deepEqual(readStatus(status({ ips })).addresses, [], JSON.stringify(ips));
  for (const text of ["", "not json", "null", "[]", "{}"]) assert.deepEqual(readStatus(text), { running: false, login: "", names: [], addresses: [] }, text);
});

test("whois names a peer's login, and never one for a tagged device or an unreadable answer", () => {
  assert.equal(readWhois(whois("Owner@example.com")), OWNER);
  assert.equal(readWhois(whois(OWNER, ["tag:ci"])), "");
  assert.equal(readWhois(whois("tagged-devices")), "");
  for (const text of ["", "{", "null", "{}", JSON.stringify({ UserProfile: {} })]) assert.equal(readWhois(text), "", text);
});

test("a peer signed in with this computer's own login passes the account check, and anyone else is refused", async () => {
  const tailscale = program({ status: status(), "100.100.1.1": whois(OWNER), "100.100.1.2": whois("guest@example.org"), "100.100.1.3": whois(OWNER, ["tag:ci"]) });
  const same = createWhois({ cli: "tailscale", run: tailscale.run });
  assert.equal(await same("100.100.1.1"), true);
  assert.equal(await same("100.100.1.2"), false, "another account on the tailnet");
  assert.equal(await same("100.100.1.3"), false, "a tagged device");
  assert.equal(await same("100.100.1.4"), false, "a peer tailscale does not know");
});

test("a failed lookup refuses the peer, and so does a computer whose own login cannot be read", async () => {
  const down = createWhois({ cli: "tailscale", run: program({ status: status(), "100.100.1.1": new Error("timeout") }).run });
  assert.equal(await down("100.100.1.1"), false);
  for (const own of [new Error("stopped"), "not json", status({ login: "" }), status({ login: "tagged-devices" })]) {
    const tailscale = program({ status: own, "100.100.1.1": whois(OWNER), "100.100.1.5": whois("tagged-devices") });
    const same = createWhois({ cli: "tailscale", run: tailscale.run });
    assert.equal(await same("100.100.1.1"), false);
    assert.equal(await same("100.100.1.5"), false, "two tagged devices are not the same person");
    assert.equal(tailscale.count("whois"), 0, "nobody is looked up while this computer's own login is unknown");
  }
});

test("a verdict is kept for a minute and a failed lookup for ten seconds, for a bounded number of peers", async () => {
  let clock = 1_000_000;
  let peer = whois(OWNER);
  const tailscale = program({ status: status(), "100.100.1.1": () => peer, "100.100.1.9": () => { throw new Error("busy"); } });
  const same = createWhois({ cli: "tailscale", run: tailscale.run, now: () => clock, max: 3 });
  assert.deepEqual(await Promise.all([same("100.100.1.1"), same("100.100.1.1"), same("100.100.1.1")]), [true, true, true]);
  assert.equal(tailscale.count("whois"), 1, "callers that arrive together share one lookup");
  peer = whois("guest@example.org");
  clock += 59_000;
  assert.equal(await same("100.100.1.1"), true, "still the saved verdict");
  clock += 2_000;
  assert.equal(await same("100.100.1.1"), false, "after a minute the peer is looked up again");
  assert.equal(tailscale.count("status"), 2, "and so is this computer's own login");

  assert.equal(await same("100.100.1.9"), false);
  clock += 9_000;
  assert.equal(await same("100.100.1.9"), false);
  assert.equal(tailscale.count("whois --json 100.100.1.9"), 1, "a failure is not retried on every request");
  clock += 2_000;
  await same("100.100.1.9");
  assert.equal(tailscale.count("whois --json 100.100.1.9"), 2, "but it is tried again after ten seconds");

  const before = tailscale.count("whois");
  for (const last of [21, 22, 23, 24]) await same(`100.100.2.${last}`);
  await same("100.100.2.24");
  assert.equal(tailscale.count("whois"), before + 4, "the newest verdicts are kept");
  await same("100.100.2.21");
  assert.equal(tailscale.count("whois"), before + 5, "the oldest made room and is looked up again");
});

test("this computer's own address is the one the tailscale program names, and nothing else ever stands in for it", async () => {
  // The review's computer: a Wi-Fi adapter that holds an address in Tailscale's range, which an internet provider can hand out.
  const both = { "Wi-Fi": [nic("100.72.9.9")], Tailscale: [nic("100.101.102.103")] };
  const says = (ip, statusText = status()) => ({ cli: "tailscale", run: program({ ip, status: statusText }).run });
  assert.equal(await ownTailscaleAddress({ interfaces: both, ...says("100.101.102.103\n") }), "100.101.102.103");
  assert.deepEqual(await tailscaleSelf({ interfaces: both, ...says("100.101.102.103\n") }), { address: "100.101.102.103", names: ["servitor.tail1234.ts.net", "servitor"] });

  for (const interfaces of [both, { "Wi-Fi": [nic("100.72.9.9")] }, { Tailscale: [nic("100.101.102.103")] }, { tailscale0: [nic("100.90.1.2")] }, { utun4: [nic("100.90.1.2")] }]) {
    assert.equal(await ownTailscaleAddress({ interfaces }), "", `with no tailscale program, no adapter is this computer's Tailscale address: ${Object.keys(interfaces)}`);
    assert.equal(await ownTailscaleAddress({ interfaces, cli: "" }), "");
    assert.equal(await ownTailscaleAddress({ interfaces, ...says(new Error("stopped")) }), "", `a tailscale program that does not answer names no address: ${Object.keys(interfaces)}`);
  }
  assert.equal(await ownTailscaleAddress({ interfaces: { "Wi-Fi": [nic("100.72.9.9")] }, ...says("100.101.102.103\n") }), "", "an address no adapter has cannot be listened on");
  assert.equal(await ownTailscaleAddress({ interfaces: both, ...says("100.72.9.9\n") }), "", "an address the status does not list is not this computer's Tailscale address");
  assert.equal(await ownTailscaleAddress({ interfaces: both, ...says("8.8.8.8\nfd7a:115c:a1e0::1\n") }), "", "only an address in the range counts as an answer");
  assert.equal(await ownTailscaleAddress({ interfaces: both, ...says("") }), "");
  for (const [why, statusText] of [["status does not answer", new Error("stopped")], ["Tailscale is not connected", status({ state: "Stopped" })],
    ["status lists another address", status({ ips: ["100.90.1.2"] })], ["status lists no address", status({ ips: [] })], ["status is not JSON", "not json"]])
    assert.equal(await ownTailscaleAddress({ interfaces: both, ...says("100.101.102.103\n", statusText) }), "", why);
  assert.equal(await ownTailscaleAddress({ interfaces: { Tailscale: [nic("100.101.102.103", { internal: true })] }, ...says("100.101.102.103\n") }), "");
  assert.equal(await ownTailscaleAddress({ interfaces: { Tailscale: [{ family: "IPv6", internal: false, address: "100.101.102.103" }] }, ...says("100.101.102.103\n") }), "");
  assert.equal(await ownTailscaleAddress({ interfaces: { tailscale0: [{ family: 4, internal: false, address: "100.101.102.103" }] }, ...says("100.101.102.103\n") }), "100.101.102.103");
});
