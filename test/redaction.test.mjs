import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../lib/claude.mjs";
import { transformThread } from "../lib/transform.mjs";
import { orcaAgentActivity } from "../lib/orca.mjs";
import { publicRequests, publicView } from "../lib/public-view.mjs";

// Synthetic credential shapes, joined at runtime so the source holds no credential-shaped literal.
const PASSWORD = ["Hunter2", "Secret!"].join("");
const STRIPE = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
const GITLAB = ["glpat", "x".repeat(20)].join("-");
const AZURE_KEY = ["abc/def", "+ghi=="].join("");
const SAS = ["sig=", "Zm9vYmFy%2Bc2lnbmF0dXJl%3D"].join("");

const SECRET_LINES = [
  [`sqlcmd -S db.local -U sa -P ${PASSWORD} -Q "select 1"`, PASSWORD],
  [`mysql -u root -p${PASSWORD} shop`, PASSWORD],
  [`curl -u admin:${PASSWORD} https://api.example.com/v1`, PASSWORD],
  [`The password is ${PASSWORD}`, PASSWORD],
  [`DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`, AZURE_KEY],
  [`export STRIPE=${STRIPE}`, STRIPE],
  [`git clone https://example.com/x.git # token ${GITLAB}`, GITLAB],
  [`https://demo.blob.core.windows.net/c/f.txt?sv=2022-11-02&se=2026-01-01&${SAS}&sp=r`, SAS.slice(4)],
];

test("each of the reviewed credential shapes comes out as [secret removed]", () => {
  for (const [text, secret] of SECRET_LINES) {
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes(secret), `${text} -> ${redacted}`);
    assert.match(redacted, /\[secret removed\]/, text);
  }
  // The words around them stay readable.
  assert.equal(redactSecrets(`sqlcmd -S db.local -U sa -P ${PASSWORD} -Q x`), "sqlcmd -S db.local -U sa -P [secret removed] -Q x");
  assert.equal(redactSecrets(`mysql -u root -p${PASSWORD} shop`), "mysql -u root -p[secret removed] shop");
  assert.equal(redactSecrets(`curl -u admin:${PASSWORD} https://x.test`), "curl -u admin:[secret removed] https://x.test");
  assert.equal(redactSecrets(`The password is "${PASSWORD}".`), 'The password is "[secret removed]".');
  assert.match(redactSecrets(`?sv=1&${SAS}&sp=r`), /^\?sv=1&sig=\[secret removed\]&sp=r$/);
});

test("ordinary text that only looks like a credential flag or word is left alone", () => {
  for (const plain of [
    "Set max_tokens: 4096 and token_count = 12.",
    "docker run -p 8080:80 web", "ssh -p 22 build.local", "-p 8080", "rsync -P src/ dest/", "git push -u origin main",
    "mysql -p shop", "sqlcmd -S db -p -Q x", "sort -u names.txt",
    "The password is incorrect.", "The token is expired, so sign in again.", "The secret is 42.",
    "config_sig=abc", "Signed the release with sig verification on.",
  ]) assert.equal(redactSecrets(plain), plain);
});

// A Codex chat whose command line, command output, and MCP arguments all carry credentials.
const SECRETS = [PASSWORD, STRIPE, GITLAB, AZURE_KEY];
const codexThread = {
  id: "thread-secret-1", name: `Deploy with ${STRIPE}`, updatedAt: 1_800_000_000, turns: [{
    id: "turn-1", status: "completed", completedAt: 1_800_000_001, items: [
      { id: "cmd-1", type: "commandExecution", command: `sqlcmd -S db -U sa -P ${PASSWORD} -Q "select 1"`,
        aggregatedOutput: `Connected with AccountKey=${AZURE_KEY}\n1 row`, exitCode: 0 },
      { id: "mcp-1", type: "mcpToolCall", server: "gitlab", tool: "create_issue",
        arguments: { project: "demo", token: GITLAB, body: `The password is ${PASSWORD}` } },
      { id: "msg-1", type: "agentMessage", phase: "final_answer", text: `Done. Used ${STRIPE}.` },
    ],
  }],
};

test("the server filters command lines, output, MCP arguments, Orca tool input, and request parameters", () => {
  const actor = transformThread(codexThread);
  const orca = orcaAgentActivity({ paneKey: "1:2", toolName: "Bash", toolInput: `curl -u admin:${PASSWORD} https://x.test`, state: "working" });
  const request = { id: 7, method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-secret-1", itemId: "cmd-2", command: `mysql -u root -p${PASSWORD}`, reason: `Needs ${GITLAB}` } };
  const scene = { root: actor, agents: [{ ...actor, id: "orca-agent:1:2", source: "orca", activities: orca, latest: orca[0] }], requests: [request] };
  const local = JSON.stringify(publicView(scene));
  for (const secret of SECRETS) assert.ok(!local.includes(secret), `${secret} leaked: ${local}`);
  const shown = publicView(scene);
  // Locally the command, its (filtered) output, and the tool's arguments are still there.
  const command = shown.root.activities.find((item) => item.kind === "command");
  assert.match(command.detail, /^sqlcmd -S db -U sa -P \[secret removed\]/);
  assert.match(command.output, /AccountKey=\[secret removed\]\n1 row/);
  assert.match(shown.root.activities.find((item) => item.kind === "tool").detail, /"token": "\[secret removed\]"/);
  assert.equal(shown.root.name, "Deploy with [secret removed]");
  // Ids are never touched, even long ones.
  const longId = `orca:${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy".repeat(2)}`;
  assert.equal(publicView({ agents: [{ id: longId, parentThreadId: longId, name: "x" }] }).agents[0].id, longId);
  assert.equal(shown.requests[0].params.threadId, "thread-secret-1");
  assert.equal(publicRequests([request])[0].params.command, "mysql -u root -p[secret removed]");
});

test("a paired phone gets no command output and no tool arguments, only titles and descriptions", () => {
  const actor = transformThread(codexThread);
  const orca = orcaAgentActivity({ paneKey: "1:2", toolName: "Bash", toolInput: "ls -la", state: "working" });
  const scene = { root: actor, agents: [{ id: "orca-agent:1:2", activities: orca, latest: orca[0] }],
    thread: actor };
  const phone = publicView(scene, { phone: true });
  for (const holder of [phone.root, phone.thread]) {
    for (const item of holder.activities) assert.equal("output" in item, false, item.id);
    const tool = holder.activities.find((item) => item.kind === "tool");
    assert.equal(tool.detail, "");
    assert.equal(tool.title, "create issue");
    assert.match(holder.activities.find((item) => item.kind === "command").detail, /-P \[secret removed\]/, "the command line stays, filtered");
  }
  assert.equal(phone.agents[0].activities[0].detail, "");
  assert.equal(phone.agents[0].latest.detail, "");
  assert.equal(phone.agents[0].activities[0].title, "Used Bash");
  for (const secret of SECRETS) assert.ok(!JSON.stringify(phone).includes(secret));
  // The original scene (the server's cache) is not changed.
  assert.ok(actor.activities.some((item) => item.output));
});
