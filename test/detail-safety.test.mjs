import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean } from "../lib/detail-text.mjs";
import { AgentDetailService, gitBranch } from "../lib/agent-detail.mjs";
import { isLocalPath } from "../lib/paths.mjs";

const REMOTE = ["\\\\files.example.test\\share\\billing-api", "//files.example.test/share/billing-api", "\\\\?\\C:\\work\\billing-api",
  "\\\\.\\pipe\\billing-api", "\\??\\C:\\work\\billing-api", "\\\\?\\UNC\\files.example.test\\share", "C:\\work\\CON", "C:\\work\\nul.txt\\x",
  "C:\\work\\billing-api:hidden", "work\\billing-api", "C:work", "/dev/tty", "/proc/self", "", null];

test("only an ordinary local folder counts as local", () => {
  for (const path of REMOTE) assert.equal(isLocalPath(path, "win32"), false, String(path));
  for (const path of ["C:\\work\\billing-api", "c:/work/billing-api", "\\work\\billing-api", "/work/billing-api"]) assert.equal(isLocalPath(path, "win32"), true, path);
  // Elsewhere a POSIX folder may hold ":" or be called "aux".
  assert.equal(isLocalPath("/home/dev/aux/a:b", "linux"), true);
  assert.equal(isLocalPath("//files.example.test/share", "linux"), false);
});

test("the git branch is never read from a share, a device, or a pointer to one", async () => {
  const reads = [];
  const files = { [join("C:\\wt", ".git")]: "gitdir: \\\\files.example.test\\share\\repo\\.git\\worktrees\\wt\n" };
  const read = (path) => { reads.push(path); if (path in files) return files[path]; throw new Error("ENOENT"); };
  for (const cwd of REMOTE) assert.equal(await gitBranch(cwd, { read }), "", String(cwd));
  assert.deepEqual(reads, [], "nothing at all was read for those folders");
  assert.equal(await gitBranch("C:\\wt", { read }), "");
  assert.ok(!reads.some((path) => path.startsWith("\\\\")), reads.join(", "));
});

test("the git branch is read from the disk asynchronously, a worktree through its relative gitdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "goblin-branch-"));
  try {
    mkdirSync(join(root, "repo", ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/ship-csv\n");
    writeFileSync(join(root, "repo", ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/fix-header\n");
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), "gitdir: ../repo/.git/worktrees/wt\n");
    const pending = gitBranch(join(root, "repo"));
    assert.ok(pending instanceof Promise);
    assert.equal(await pending, "ship-csv");
    assert.equal(await gitBranch(join(root, "wt")), "fix-header");
    // A HEAD that is a folder, not a file, is not a branch.
    mkdirSync(join(root, "odd", ".git", "HEAD"), { recursive: true });
    assert.equal(await gitBranch(join(root, "odd")), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function detailWorld(actor, branch, clock = () => 1_000) {
  return new AgentDetailService({
    scene: async () => ({ agents: [actor] }),
    claude: { snapshot: () => ({ sessions: [] }), records: () => [] },
    extensions: { snapshot: () => ({ sessions: [] }) },
    branch, clock, branchWaitMs: 50,
  });
}

test("the agent detail never reads an extension feed's folder or a share, and remembers a failed read", async () => {
  const calls = [];
  const failing = (cwd) => { calls.push(cwd); throw new Error("EACCES"); };
  const ext = { id: "ext-agent:relay:night-run:scout", source: "extension", name: "Scout", cwd: "C:\\work\\billing-api", activities: [] };
  assert.equal((await detailWorld(ext, failing).detail(ext.id)).agent.branch, undefined);
  const share = { id: "claude-agent:sess-1", source: "claude", name: "Claude", cwd: "\\\\files.example.test\\share\\billing-api", activities: [] };
  assert.equal((await detailWorld(share, failing).detail(share.id)).agent.branch, undefined);
  assert.deepEqual(calls, []);
  let now = 1_000;
  const local = { ...share, cwd: "C:\\work\\billing-api" };
  const service = detailWorld(local, failing, () => now);
  await service.detail(local.id);
  now += 30_000;
  await service.detail(local.id);
  assert.equal(calls.length, 1, "a failed read is remembered too");
  now += 60_000;
  await service.detail(local.id);
  assert.equal(calls.length, 2, "and tried again a minute later");
});

test("a slow branch read never holds up the agent detail, and is not started twice", async () => {
  let started = 0;
  let finish;
  const slow = () => { started++; return new Promise((done) => { finish = done; }); };
  const actor = { id: "claude-agent:sess-2", source: "claude", name: "Claude", cwd: "C:\\work\\billing-api", activities: [] };
  const service = detailWorld(actor, slow);
  const begun = Date.now();
  const first = await service.detail(actor.id);
  assert.ok(Date.now() - begun < 1000);
  assert.equal(first.agent.branch, undefined);
  await service.detail(actor.id);
  assert.equal(started, 1, "the read still running is shared");
  finish("ship-csv");
  await new Promise((done) => setImmediate(done));
  assert.equal((await service.detail(actor.id)).agent.branch, "ship-csv");
  assert.equal(started, 1);
});

test("a megabyte pasted into a prompt is clipped before it is filtered", () => {
  const secret = "Win" + "ter2026!x";
  const pasted = `   Deploy with password=${secret} now. ${"lorem ipsum ".repeat(90_000)}`;
  const started = Date.now();
  const text = clean(pasted, 2000);
  assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
  assert.equal(text.length, 2000);
  assert.ok(text.startsWith("Deploy with password=[secret removed] now."));
  assert.ok(text.endsWith("…"));
  assert.equal(text.includes(secret), false);
  // Short text is unchanged by the cut.
  assert.equal(clean(`  token=${secret}  `, 2000), "token=[secret removed]");
  // A credential straddling the clip point is still recognised whole before the cut.
  const straddle = clean(`${"x ".repeat(45)}password=${secret}${" y".repeat(100)}`, 100);
  assert.equal(straddle.includes("Win"), false, straddle);
});
