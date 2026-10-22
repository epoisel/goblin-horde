/**
 * Synthetic tasks and transcripts for `/app#demo`, in the exact shapes `/api/tasks` and
 * `/api/transcript` answer (SPEC2), so the task view can be built and checked before the server
 * routes exist. Every name, path, and line here is invented.
 *
 * The demo is alive: entries appear and running tool calls finish as time passes (worker questions
 * get answered, tests finish, the coordinator checks in), so appending, patching, the "new" pill,
 * and auto-scroll can all be seen. Cursors behave like the server's: `after` returns only new or
 * changed entries, `before` pages older ones. Answers, replies, dismissals and joins change the
 * demo's state the way the real routes would.
 *
 * Tasks: a Codex lead driving an Orca coordinator with three workers (one asking the coordinator,
 * one running tests with a 300 KB output, one finished); a Claude Code session with two subagents;
 * a Codex chat waiting on an approval; a failed chat; a finished one; a transcript that cannot be
 * read; a session with nothing in it yet; and one older task that only the 7-day window shows.
 */

const S = 1000;
const M = 60 * S;
const H = 60 * M;

const MODELS = {
  sol: { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", family: "openai", effort: "high" },
  codex: { id: "gpt-5-codex", label: "GPT-5 Codex", family: "openai" },
  opus: { id: "claude-opus-5-5", label: "Opus 5.5", family: "claude" },
  sonnet: { id: "claude-sonnet-4-5", label: "Sonnet 4.5", family: "claude" },
  haiku: { id: "claude-haiku-4-5", label: "Haiku 4.5", family: "claude" },
};

const ID = {
  lead: "019a3c1e-7d2f-7a10-lead-checkout",
  coord: "orca:marigold:term-coordinator",
  pay: "orca:marigold:term-payments",
  tests: "orca:marigold:term-tests",
  docs: "orca:marigold:term-docs",
  lantern: "claude-agent:lantern-session",
  explore: "claude-agent:lantern-session:explore-readers",
  bench: "claude-agent:lantern-session:bench-tokenizer",
  config: "019a3c22-11ab-7c3e-config-loader",
  flaky: "019a3b90-5e1d-7f02-flaky-upload",
  notes: "claude-agent:release-notes",
  theme: "claude-agent:theme-tokens",
  fresh: "claude-agent:fresh-session",
  audit: "019a2f01-0c9e-7b55-migration-audit",
  // A wide Codex → Orca task: a lead, a coordinator, and seven workers, four of them named alike.
  roundLead: "019a3d40-2b6e-7c11-round-lead",
  roundCoord: "orca:kettle:term-round-coord",
  roundTotals: "orca:kettle:term-round-totals",
  roundReceipts: "orca:kettle:term-round-receipts",
  roundRefunds: "orca:kettle:term-round-refunds",
  roundTax: "orca:kettle:term-round-tax",
  roundFind: "orca:kettle:term-round-find",
  roundSuite: "orca:kettle:term-round-suite",
  roundDocs: "orca:kettle:term-round-docs",
  // Subagents the search session ran earlier: yesterday's are stale, one finished a little while ago.
  lanternRfc: "claude-agent:lantern-session:rfc-draft",
  lanternParser: "claude-agent:lantern-session:map-parser",
  lanternCold: "claude-agent:lantern-session:cold-starts",
  lanternStops: "claude-agent:lantern-session:stop-words",
};

/** The wide task's workers: id, name, model, what they do, and how far they got. */
const ROUND_WORKERS = [
  ["roundTotals", "General-purpose: Fix rounding in totals", "sonnet", "src/money/totals.ts", "working"],
  ["roundReceipts", "General-purpose: Fix rounding in receipts", "sonnet", "src/receipts/lines.ts", "working"],
  ["roundRefunds", "General-purpose: Fix rounding in refunds", "haiku", "src/refunds/partial.ts", "asking"],
  ["roundTax", "General-purpose: Fix rounding in tax lines", "sonnet", "src/tax/lines.ts", "working"],
  ["roundFind", "Explore: Find every float multiply", "haiku", "src", "done"],
  ["roundSuite", "Test runner: money suite", "opus", "test/money", "working"],
  ["roundDocs", "Docs: rounding rules page", "codex", "docs/money.md", "idle"],
];

// ---- Text builders ----

const lines = (...parts) => parts.join("\n");

/** A big jest-style log (about 300 KB), with one failing suite in the middle and colour codes. */
function bigTestLog() {
  const suites = ["cart", "pricing", "payments", "refunds", "shipping", "tax", "coupons", "inventory", "session", "receipts", "addresses", "giftcards"];
  const checks = ["adds an item", "removes an item", "keeps totals in cents", "rounds half to even", "rejects a negative quantity",
    "applies a percentage coupon", "stacks two coupons in order", "reads the saved cart", "retries a declined card once",
    "formats the receipt total", "keeps the currency of the first item", "drops an expired session"];
  const out = ["> marigold-shop@3.8.0 test", "> jest --runInBand", ""];
  let size = 0;
  let file = 0;
  let passed = 0;
  // About 300 KB once the colour codes are taken out.
  while (size < 300 * 1024) {
    const from = out.length;
    const suite = suites[file % suites.length];
    const failing = file === 140;
    out.push(`${failing ? "\x1b[41m FAIL \x1b[0m" : "\x1b[42m PASS \x1b[0m"} test/${suite}/${suite}-${String(file).padStart(3, "0")}.test.ts (${(((file * 37) % 900) / 100 + 0.4).toFixed(2)}s)`);
    for (let k = 0; k < 6; k++) {
      const name = checks[(file + k * 5) % checks.length];
      if (failing && k === 2) {
        out.push(`    \x1b[31m✕ ${name} (${12 + k} ms)\x1b[0m`);
      } else {
        out.push(`    \x1b[32m✓\x1b[0m ${name} (${(file * 7 + k * 13) % 90 + 1} ms)`);
        passed++;
      }
    }
    if (failing) {
      out.push("", "  ● payments › keeps totals in cents", "",
        "    expect(received).toBe(expected) // Object.is equality", "",
        "    Expected: 1999", "    Received: 1998.9999999999998", "",
        "      42 |   const total = cart.lines.reduce((sum, line) => sum + line.price * line.qty, 0);",
        "      43 |   const charged = await adapter.charge(total);",
        "    > 44 |   expect(charged.amount).toBe(1999);",
        "         |                          ^",
        "      45 | });", "",
        "      at Object.<anonymous> (test/payments/payments-140.test.ts:44:26)", "");
    }
    for (let index = from; index < out.length; index++) size += out[index].replace(/\x1b\[[0-9;]*m/g, "").length + 1;
    file++;
  }
  out.push("", `Test Suites: 1 failed, ${file - 1} passed, ${file} total`, `Tests:       1 failed, ${passed} passed, ${passed + 1} total`,
    "Snapshots:   48 passed, 48 total", "Time:        212.48 s", "Ran all test suites.");
  return out.join("\n");
}

const PAYMENTS_DIFF = lines(
  "diff --git a/src/checkout/payments.ts b/src/checkout/payments.ts",
  "index 4b1c2d0..9e7f3a1 100644",
  "--- a/src/checkout/payments.ts",
  "+++ b/src/checkout/payments.ts",
  "@@ -1,38 +1,61 @@",
  "-import { LegacyGateway } from \"../legacy/gateway\";",
  "+import { PaymentAdapter, type ChargeResult } from \"./adapter\";",
  "+import { toCents, fromCents } from \"../money\";",
  " import { logger } from \"../log\";",
  " import type { Cart } from \"./cart\";",
  " ",
  "-const gateway = new LegacyGateway({ retries: 0 });",
  "+// One adapter per process: it keeps the provider's session warm between charges.",
  "+const adapter = new PaymentAdapter({ retries: 1, timeoutMs: 8000 });",
  " ",
  "-export async function chargeCart(cart: Cart) {",
  "-  const total = cart.lines.reduce((sum, line) => sum + line.price * line.qty, 0);",
  "-  const result = await gateway.charge(total, cart.currency);",
  "-  if (!result.ok) {",
  "-    logger.warn(\"charge failed\", { cart: cart.id });",
  "-    throw new Error(\"Payment failed\");",
  "-  }",
  "-  return result;",
  "+export interface ChargeOptions {",
  "+  /** Ask the provider to hold the money without capturing it (for pre-orders). */",
  "+  authorizeOnly?: boolean;",
  "+  /** A key that makes a retried charge safe: the provider charges once per key. */",
  "+  idempotencyKey: string;",
  " }",
  " ",
  "-export async function refund(chargeId: string, amount: number) {",
  "-  return gateway.refund(chargeId, amount);",
  "+export async function chargeCart(cart: Cart, options: ChargeOptions): Promise<ChargeResult> {",
  "+  // Totals are summed in cents: 19.99 * 3 in floating point is not 59.97.",
  "+  const cents = cart.lines.reduce((sum, line) => sum + toCents(line.price) * line.qty, 0);",
  "+  const result = await adapter.charge({",
  "+    amount: cents,",
  "+    currency: cart.currency,",
  "+    capture: !options.authorizeOnly,",
  "+    idempotencyKey: options.idempotencyKey,",
  "+  });",
  "+  if (result.status === \"declined\") {",
  "+    logger.warn(\"charge declined\", { cart: cart.id, reason: result.reason });",
  "+    return result;",
  "+  }",
  "+  if (result.status === \"error\") {",
  "+    logger.error(\"charge failed\", { cart: cart.id, code: result.code });",
  "+    throw new PaymentError(result.code, fromCents(cents));",
  "+  }",
  "+  return result;",
  "+}",
  "+",
  "+export class PaymentError extends Error {",
  "+  constructor(readonly code: string, readonly amount: number) {",
  "+    super(`Payment failed (${code}) for ${amount.toFixed(2)}`);",
  "+  }",
  " }",
  " ",
  " export function describeCharge(result: ChargeResult) {",
  "-  return `${result.amount} ${result.currency}`;",
  "+  return `${fromCents(result.amount).toFixed(2)} ${result.currency}`;",
  " }",
  "@@ -52,9 +75,12 @@ export function receiptLines(cart: Cart) {",
  "   return cart.lines.map((line) => ({",
  "     label: line.name,",
  "-    amount: line.price * line.qty,",
  "+    amount: fromCents(toCents(line.price) * line.qty),",
  "+    // Gift cards show their code's last four characters, never the whole code.",
  "+    note: line.giftCard ? `Gift card ending ${line.giftCard.slice(-4)}` : undefined,",
  "   }));",
  " }",
  " ",
  "-export const PROVIDER = \"legacy\";",
  "+export const PROVIDER = \"marigold-pay\";",
  "+export const PROVIDER_VERSION = 3;",
  "\\ No newline at end of file",
);

const ADAPTER_FILE = lines(
  "import { request } from \"../http\";",
  "",
  "export type ChargeStatus = \"captured\" | \"authorized\" | \"declined\" | \"error\";",
  "",
  "export interface ChargeResult {",
  "  id: string;",
  "  status: ChargeStatus;",
  "  amount: number; // cents",
  "  currency: string;",
  "  reason?: string;",
  "  code?: string;",
  "}",
  "",
  "export class PaymentAdapter {",
  "  constructor(private readonly options: { retries: number; timeoutMs: number }) {}",
  "",
  "  async charge(input: { amount: number; currency: string; capture: boolean; idempotencyKey: string }): Promise<ChargeResult> {",
  "    let attempt = 0;",
  "    for (;;) {",
  "      try {",
  "        return await request(\"/v3/charges\", { method: \"POST\", body: input, timeoutMs: this.options.timeoutMs });",
  "      } catch (error) {",
  "        if (attempt++ >= this.options.retries) return { id: \"\", status: \"error\", amount: input.amount, currency: input.currency, code: String(error) };",
  "      }",
  "    }",
  "  }",
  "}",
);

const newFileDiff = (path, content) => {
  const body = content.split("\n");
  return lines(`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((line) => `+${line}`));
};

/** A long generated snapshot: the "big diff" (several hundred lines). */
function snapshotDiff() {
  const rows = [];
  for (let index = 0; index < 340; index++) {
    rows.push(`   <tr data-row="${index}">`);
    rows.push(`     <td class="sku">MG-${String(4000 + index)}</td>`);
  }
  const old = [];
  const now = [];
  for (let index = 0; index < 340; index++) {
    old.push(`-    <td class="price">${(index * 1.37 + 3).toFixed(2)}</td>`);
    now.push(`+    <td class="price">${(index * 1.37 + 3).toFixed(2)} USD</td>`);
  }
  const body = [];
  for (let index = 0; index < 340; index++) body.push(rows[index * 2], rows[index * 2 + 1], old[index], now[index]);
  return lines("diff --git a/test/__snapshots__/receipt.test.ts.snap b/test/__snapshots__/receipt.test.ts.snap",
    "--- a/test/__snapshots__/receipt.test.ts.snap", "+++ b/test/__snapshots__/receipt.test.ts.snap",
    "@@ -10,1020 +10,1020 @@ exports[`receipt table 1`] = `", ...body);
}

const CHANGELOG_DIFF = lines(
  "--- a/CHANGELOG.md",
  "+++ b/CHANGELOG.md",
  "@@ -1,6 +1,14 @@",
  " # Changelog",
  " ",
  "+## 3.9.0 (unreleased)",
  "+",
  "+- Checkout charges through the new Marigold Pay adapter; totals are summed in cents.",
  "+- A retried charge is safe: every charge carries an idempotency key.",
  "+- Receipts show gift cards by their last four characters only.",
  "+- Refunds stay on the legacy gateway for this release.",
  "+",
  " ## 3.8.0",
  " ",
  " - Saved carts survive a sign-out.",
);

const LEAD_PLAN_MESSAGE = lines(
  "Here's the plan for the checkout rewrite. I've split it so three workers can go in parallel under one coordinator, and I'll keep an eye on the run from here.",
  "",
  "## Workstreams",
  "",
  "| # | Worker | Owns | Done when |",
  "|:-:|--------|------|-----------|",
  "| 1 | **Payments adapter** | `src/checkout/payments.ts`, new `adapter.ts` | typecheck passes, charges go through `PaymentAdapter` |",
  "| 2 | **Test runner** | `test/**` | full suite green, flaky receipt snapshot fixed |",
  "| 3 | **Docs and changelog** | `docs/checkout.md`, `CHANGELOG.md` | changelog entry + migration notes |",
  "",
  "## Decisions so far",
  "",
  "1. Money is summed in **integer cents** everywhere in checkout. The current code multiplies floats:",
  "   ```ts",
  "   const total = cart.lines.reduce((sum, line) => sum + line.price * line.qty, 0);",
  "   // 19.99 * 3 === 59.97000000000001",
  "   ```",
  "2. Every charge carries an *idempotency key* so a retry can never double-charge.",
  "3. Refunds are ~~moved in this release~~ left on the legacy gateway until the provider confirms partial refunds.",
  "",
  "> The coordinator decides anything a worker asks; it only comes back to me for scope changes.",
  "",
  "### How I'm driving it",
  "",
  "```powershell",
  "orca orchestration run create --name checkout-rewrite --coordinator term-coordinator",
  "orca orchestration dispatch --run checkout-rewrite --to term-payments --task payments-adapter",
  "orca orchestration dispatch --run checkout-rewrite --to term-tests --task test-suite",
  "orca orchestration dispatch --run checkout-rewrite --to term-docs --task docs",
  "```",
  "",
  "Provider docs for reference: [Marigold Pay charges API](https://docs.example.com/pay/v3/charges) and the idempotency notes at https://docs.example.com/pay/v3/idempotency.",
  "",
  "- [x] Read the current checkout code",
  "- [x] Agree the money rules",
  "- [ ] Land the adapter",
  "- [ ] Green suite",
);

const COORD_BRIEF = lines(
  "You are the coordinator for the **checkout-rewrite** run in `C:\\code\\marigold-shop`.",
  "",
  "Goal: replace the legacy gateway in checkout with the new `PaymentAdapter`, keep every test green, and document the change.",
  "",
  "Rules:",
  "- Sum money in integer cents. Never multiply float prices.",
  "- Every charge gets an idempotency key (use the cart id plus the attempt number).",
  "- Refunds: out of scope unless I say otherwise.",
  "- Workers ask you, not me. Escalate only scope changes.",
  "",
  "Workers and their tasks:",
  "1. `term-payments` — payments adapter (src/checkout/payments.ts, new src/checkout/adapter.ts)",
  "2. `term-tests` — run the full suite, fix the receipt snapshot, report failures with the exact assertion",
  "3. `term-docs` — CHANGELOG.md and docs/checkout.md",
  "",
  "Report back with a short status table when all three are done. Keep each worker's brief self-contained: they cannot see this message.",
  "",
  "Context from the planning chat:",
  "- The provider's sandbox accepts any card ending 4242.",
  "- Typecheck with `npm run typecheck`; the suite takes about four minutes with --runInBand.",
  "- The receipt snapshot has been flaky since the currency column was added.",
  "- Do not touch `src/legacy/**`.",
);

const LANTERN_REPORT = lines(
  "I've finished the tuning pass. Short version: **query latency p95 drops from 184 ms to 61 ms** and the index is 22% smaller, with no change in the top-10 results on the evaluation set.",
  "",
  "### What changed",
  "",
  "| Change | Index size | p50 | p95 | Recall@10 |",
  "|--------|-----------:|----:|----:|----------:|",
  "| Baseline | 412 MB | 38 ms | 184 ms | 0.912 |",
  "| Shorter n-grams (3 → 2..3) | 388 MB | 31 ms | 142 ms | 0.914 |",
  "| Drop stop-word postings | 341 MB | 22 ms | 88 ms | 0.911 |",
  "| **Both + block-max WAND** | **321 MB** | **17 ms** | **61 ms** | **0.913** |",
  "",
  "The tokenizer change is the riskiest part, so it's behind a flag:",
  "",
  "```rust",
  "pub fn tokenizer(config: &IndexConfig) -> Box<dyn Tokenizer> {",
  "    // Two- and three-grams keep short identifiers (\"io\", \"db\") findable.",
  "    let grams = if config.short_grams { 2..=3 } else { 3..=3 };",
  "    Box::new(NgramTokenizer::new(grams).with_stop_words(config.stop_words.clone()))",
  "}",
  "```",
  "",
  "And the rebuild command for anyone trying it locally:",
  "",
  "```bash",
  "cargo run --release --bin lantern-index -- rebuild --short-grams --drop-stop-words ./corpus",
  "```",
  "",
  "#### Caveats",
  "",
  "1. Recall@10 moves within noise (±0.002), but *phrase* queries got slightly worse on two docs: `\"set up\"` and `\"log in\"`.",
  "2. The explore subagent found **four** readers of the index format; all four are updated:",
  "   - `crates/search/src/reader.rs`",
  "   - `crates/search/src/merge.rs`",
  "   - `crates/cli/src/inspect.rs`",
  "   - `tools/index-dump/main.rs`",
  "3. The benchmark subagent is still running the cold-cache numbers; I'll update this table when it reports.",
  "",
  "Want me to open a PR with the flag off by default?",
);

// ---- Entry builders ----

function builder(prefix) {
  let count = 0;
  const id = () => `${prefix}-${String(++count).padStart(4, "0")}`;
  const tool = (at, fields, extra = {}) => ({ id: id(), at, kind: "tool", ...extra,
    tool: { name: "shell", kind: "command", title: "", input: "", status: "ok", exitCode: null, durationMs: null, output: "", diff: "", files: [], ...fields } });
  return {
    prompt: (at, text, from = "you") => ({ id: id(), at, kind: "prompt", from, text }),
    msg: (at, text) => ({ id: id(), at, kind: "message", text }),
    reason: (at, text) => ({ id: id(), at, kind: "reasoning", text }),
    sys: (at, text) => ({ id: id(), at, kind: "system", text }),
    compact: (at, text) => ({ id: id(), at, kind: "compaction", text }),
    err: (at, text) => ({ id: id(), at, kind: "error", text }),
    plan: (at, steps, explanation = "") => ({ id: id(), at, kind: "plan", plan: { steps: steps.map(([status, text]) => ({ status, text })), explanation } }),
    ask: (at, ask) => ({ id: id(), at, kind: "ask", ask }),
    sub: (at, agentId, fields) => ({ id: id(), at, kind: "subagent", agentId,
      tool: { name: "Agent", kind: "agent", title: "", input: "", status: "ok", exitCode: null, durationMs: null, output: "", diff: "", files: [], agentId, ...fields } }),
    cmd: (at, command, fields = {}) => tool(at, { name: "shell", kind: "command", input: command, exitCode: 0, ...fields }),
    read: (at, path, output, fields = {}) => tool(at, { name: "Read", kind: "read", input: JSON.stringify({ file_path: path }, null, 2), output, files: [{ path }], ...fields }),
    search: (at, pattern, output, fields = {}) => tool(at, { name: "Grep", kind: "search", input: JSON.stringify({ pattern, path: "." }, null, 2), output, ...fields }),
    edit: (at, path, diff, fields = {}) => tool(at, { name: "Edit", kind: "edit", input: JSON.stringify({ file_path: path }, null, 2), diff, files: [{ path }], ...fields }),
    write: (at, path, content, fields = {}) => tool(at, { name: "Write", kind: "write", input: JSON.stringify({ file_path: path }, null, 2), diff: newFileDiff(path, content), files: [{ path, added: content.split("\n").length, removed: 0 }], ...fields }),
    web: (at, url, output, fields = {}) => tool(at, { name: "WebFetch", kind: "web", input: JSON.stringify({ url }, null, 2), output, ...fields }),
    mcp: (at, name, args, output, fields = {}) => tool(at, { name, kind: "mcp", input: JSON.stringify(args, null, 2), output, ...fields }),
  };
}

/** A running entry that finishes at `doneAt` with `final` merged into its tool. */
const finishes = (entry, doneAt, final) => ({ ...entry, doneAt, final, tool: { ...entry.tool, status: "running", exitCode: null, durationMs: null, output: "" } });

// ---- The scripted transcripts ----

function leadEntries(T) {
  const b = builder("lead");
  const out = [];
  // Twenty earlier turns, so the column pages backwards.
  const topics = ["cart totals", "coupon stacking", "the receipt layout", "session expiry", "tax rounding", "address validation", "gift cards",
    "inventory holds", "the shipping table", "currency display", "saved carts", "order emails", "the legacy gateway", "retry rules", "error copy",
    "analytics events", "feature flags", "the pre-order flow", "the payment form", "load tests"];
  let at = T - 13 * H;
  [...topics, ...topics.map((topic) => `${topic} again`)].forEach((topic, index) => {
    out.push(b.prompt(at, `Can you look at ${topic} and tell me what would change if checkout moved to integer cents?`));
    out.push(b.reason(at + 4 * S, `Looking at ${topic}: find where amounts are computed, check for float math, and list the call sites.`));
    out.push(b.search(at + 9 * S, topic.split(" ").at(-1), `src/checkout/${topic.replace(/\s+/g, "-")}.ts:${12 + index}:  const amount = price * qty;\nsrc/checkout/summary.ts:${40 + index}:  // ${topic}`, { durationMs: 210 + index * 7 }));
    out.push(b.read(at + 14 * S, `src/checkout/${topic.replace(/\s+/g, "-")}.ts`, `export function ${topic.replace(/\s+(\w)/g, (_, c) => c.toUpperCase())}() {\n  // ...\n}`, { durationMs: 40 }));
    out.push(b.cmd(at + 20 * S, `npm run typecheck -- --project src/checkout`, { output: "tsc -p src/checkout\n\nFound 0 errors.", durationMs: 8200 + index * 100 }));
    out.push(b.msg(at + 31 * S, `For **${topic}**, the change is small: ${index % 2 ? "two" : "one"} call ${index % 2 ? "sites multiply" : "site multiplies"} float prices. Switching to \`toCents()\` there is enough.`));
    at += 17 * M;
  });
  at = T - 52 * M;
  out.push(b.prompt(at, lines("OK, let's do the rewrite for real. Use Orca: one coordinator, three workers (payments adapter, tests, docs).",
    "Keep refunds out of it. I want to watch it run, so keep the coordinator's briefs complete.")));
  out.push(b.reason(at + 6 * S, lines("**Planning the run**", "", "The work splits cleanly by file ownership: adapter code, tests, docs. The risk is the money rules drifting between workers, so they go in the coordinator brief verbatim.")));
  out.push(b.plan(at + 10 * S, [["done", "Read the current checkout code"], ["done", "Agree the money rules"], ["active", "Start the Orca run with a coordinator"], ["pending", "Dispatch three workers"], ["pending", "Review the adapter diff"], ["pending", "Green suite"], ["pending", "Write the summary"]],
    "Seven steps; the workers own steps 5 and 6."));
  out.push(b.cmd(at + 15 * S, "orca status --json", { output: "{\n  \"state\": \"running\",\n  \"workspaces\": 3,\n  \"terminals\": 7\n}", durationMs: 640 }));
  out.push(b.cmd(at + 22 * S, "orca orchestration run create --name checkout-rewrite --coordinator term-coordinator", { output: "Created run checkout-rewrite (coordinator: term-coordinator)", durationMs: 1210 }));
  out.push(b.cmd(at + 30 * S, `orca terminal send --terminal term-coordinator --text-file brief-checkout.md`, { output: "Sent 1,184 characters to term-coordinator.", durationMs: 380 }));
  out.push(b.msg(at + 41 * S, LEAD_PLAN_MESSAGE));
  out.push(b.plan(at + 50 * S, [["done", "Read the current checkout code"], ["done", "Agree the money rules"], ["done", "Start the Orca run with a coordinator"], ["done", "Dispatch three workers"], ["active", "Review the adapter diff"], ["pending", "Green suite"], ["pending", "Write the summary"]]));
  out.push(b.cmd(at + 58 * S, "orca orchestration status --run checkout-rewrite --json", { durationMs: 900,
    output: "{\n  \"run\": \"checkout-rewrite\",\n  \"tasks\": [\n    { \"id\": \"payments-adapter\", \"assignee\": \"term-payments\", \"status\": \"in_progress\" },\n    { \"id\": \"test-suite\", \"assignee\": \"term-tests\", \"status\": \"in_progress\" },\n    { \"id\": \"docs\", \"assignee\": \"term-docs\", \"status\": \"done\" }\n  ]\n}" }));
  out.push(b.msg(at + 70 * S, "The run is going. Docs are done already; the adapter and the suite are in progress. I'll wait on the coordinator's report rather than poll every minute."));
  out.push(finishes(b.cmd(T - 40 * S, "orca orchestration wait --run checkout-rewrite --for report --timeout 30m"), T + 75 * S,
    { status: "ok", exitCode: 0, durationMs: 115 * S, output: "Report received from term-coordinator (4 tasks, 0 open questions)." }));
  return out;
}

function coordEntries(T) {
  const b = builder("coord");
  const out = [];
  let at = T - 50 * M;
  out.push(b.sys(at, "Session started in Orca terminal term-coordinator · C:\\code\\marigold-shop"));
  out.push(b.prompt(at + 2 * S, COORD_BRIEF, "parent"));
  out.push(b.reason(at + 8 * S, "Three workers, disjoint files. The tests worker should start right away since the suite is slow; the adapter worker needs the money rules spelled out."));
  out.push(b.plan(at + 12 * S, [["done", "Read the brief"], ["active", "Brief the payments worker"], ["pending", "Brief the tests worker"], ["pending", "Brief the docs worker"], ["pending", "Answer worker questions"], ["pending", "Review the adapter diff"], ["pending", "Report to the planning chat"]]));
  out.push(b.cmd(at + 20 * S, "orca orchestration dispatch --run checkout-rewrite --to term-payments --task payments-adapter --brief-file brief-payments.md", { output: "Dispatched payments-adapter to term-payments.", durationMs: 820 }));
  out.push(b.cmd(at + 26 * S, "orca orchestration dispatch --run checkout-rewrite --to term-tests --task test-suite --brief-file brief-tests.md", { output: "Dispatched test-suite to term-tests.", durationMs: 790 }));
  out.push(b.cmd(at + 31 * S, "orca orchestration dispatch --run checkout-rewrite --to term-docs --task docs --brief-file brief-docs.md", { output: "Dispatched docs to term-docs.", durationMs: 760 }));
  out.push(b.plan(at + 34 * S, [["done", "Read the brief"], ["done", "Brief the payments worker"], ["done", "Brief the tests worker"], ["done", "Brief the docs worker"], ["active", "Answer worker questions"], ["pending", "Review the adapter diff"], ["pending", "Report to the planning chat"]]));
  out.push(b.msg(at + 40 * S, "All three workers are briefed. I'll answer questions as they come in and review the adapter diff when it lands."));
  out.push(b.cmd(T - 18 * M, "orca orchestration inbox --run checkout-rewrite", { durationMs: 450,
    output: "term-docs     done      docs: CHANGELOG.md and docs/checkout.md updated (2 files)\nterm-tests    working   test-suite: first full run failed (1 test), fixing\nterm-payments working   payments-adapter: adapter in place, typecheck clean" }));
  out.push(b.read(T - 16 * M, "CHANGELOG.md", "# Changelog\n\n## 3.9.0 (unreleased)\n\n- Checkout charges through the new Marigold Pay adapter; totals are summed in cents.\n...", { durationMs: 30 }));
  out.push(b.msg(T - 15 * M, "Docs look right. Marking the docs task done."));
  out.push(b.cmd(T - 3 * M, "orca orchestration inbox --run checkout-rewrite --wait 60", { durationMs: 2100,
    output: "term-payments  question  payments-adapter: Should refunds go through the new adapter too, or stay on the legacy path for this release?" }));
  out.push(b.reason(T - 2 * M, "The brief says refunds are out of scope. Answer directly; no need to escalate."));
  // The answer goes out a little after the page opens, so the worker's wait can be seen ending.
  out.push({ ...b.cmd(T + 18 * S, "orca orchestration reply --run checkout-rewrite --to term-payments --text \"Refunds stay on the legacy gateway this release. Leave refund() calling LegacyGateway; add a TODO with the ticket.\"",
    { output: "Replied to term-payments.", durationMs: 520 }) });
  out.push(b.msg(T + 21 * S, "Answered the payments worker: refunds stay on the legacy gateway for this release."));
  out.push(b.plan(T + 24 * S, [["done", "Read the brief"], ["done", "Brief the payments worker"], ["done", "Brief the tests worker"], ["done", "Brief the docs worker"], ["done", "Answer worker questions"], ["active", "Review the adapter diff"], ["pending", "Report to the planning chat"]]));
  return out;
}

function paymentsEntries(T) {
  const b = builder("pay");
  const out = [];
  let at = T - 47 * M;
  out.push(b.prompt(at, lines("**Task: payments-adapter** (from the checkout-rewrite coordinator)", "",
    "Replace the legacy gateway in `src/checkout/payments.ts` with a new `PaymentAdapter` in `src/checkout/adapter.ts`.", "",
    "- Sum money in integer cents (`toCents`/`fromCents` in `src/money.ts`).", "- Every charge takes an `idempotencyKey`.", "- Keep `describeCharge` and `receiptLines` working.",
    "- Run `npm run typecheck` before you report.", "", "Ask me (the coordinator) if anything is unclear."), "coordinator"));
  out.push(b.reason(at + 5 * S, "Start by reading the current payments module and the money helpers."));
  out.push(b.read(at + 9 * S, "src/checkout/payments.ts", "import { LegacyGateway } from \"../legacy/gateway\";\nimport { logger } from \"../log\";\n...\nexport const PROVIDER = \"legacy\";", { durationMs: 25 }));
  out.push(b.read(at + 12 * S, "src/money.ts", "export const toCents = (value: number) => Math.round(value * 100);\nexport const fromCents = (cents: number) => cents / 100;", { durationMs: 18 }));
  out.push(b.search(at + 16 * S, "chargeCart\\(", "src/checkout/submit.ts:31:  const result = await chargeCart(cart);\nsrc/checkout/preorder.ts:58:  await chargeCart(cart);\ntest/payments/payments-140.test.ts:43:  const charged = await chargeCart(cart);", { durationMs: 190 }));
  out.push(b.write(at + 3 * M, "src/checkout/adapter.ts", ADAPTER_FILE, { durationMs: 60 }));
  out.push(b.edit(at + 5 * M, "src/checkout/payments.ts", PAYMENTS_DIFF, { durationMs: 80 }));
  out.push(b.edit(at + 6 * M, "src/checkout/submit.ts", lines("--- a/src/checkout/submit.ts", "+++ b/src/checkout/submit.ts", "@@ -29,5 +29,8 @@ export async function submit(cart: Cart) {",
    "   validate(cart);", "-  const result = await chargeCart(cart);", "+  const result = await chargeCart(cart, {", "+    idempotencyKey: `${cart.id}:${cart.attempt}`,", "+  });",
    "   return confirm(cart, result);", " }"), { durationMs: 40 }));
  out.push(b.cmd(at + 7 * M, "npm run typecheck", { output: "> marigold-shop@3.8.0 typecheck\n> tsc --noEmit -p .\n\n", durationMs: 14_300 }));
  out.push(b.msg(at + 8 * M, "The adapter is in and typecheck is clean. One open question before I touch `refund()`: it still calls the legacy gateway."));
  out.push(b.msg(T - 3 * M - 20 * S, "**Question for the coordinator:** should refunds go through the new adapter too, or stay on the legacy path for this release?"));
  out.push(finishes(b.cmd(T - 3 * M, "orca orchestration ask --run checkout-rewrite --to coordinator --text \"Should refunds go through the new adapter too, or stay on the legacy path for this release?\" --wait"),
    T + 19 * S, { status: "ok", exitCode: 0, durationMs: 3 * M + 19 * S, output: "Coordinator: Refunds stay on the legacy gateway this release. Leave refund() calling LegacyGateway; add a TODO with the ticket." }));
  out.push(b.prompt(T + 20 * S, "Refunds stay on the legacy gateway this release. Leave refund() calling LegacyGateway; add a TODO with the ticket.", "coordinator"));
  out.push(b.edit(T + 30 * S, "src/checkout/payments.ts", lines("--- a/src/checkout/payments.ts", "+++ b/src/checkout/payments.ts", "@@ -64,3 +64,6 @@",
    "+// TODO(CHK-212): move refunds to PaymentAdapter once partial refunds ship.", "+export async function refund(chargeId: string, amount: number) {", "+  return new LegacyGateway({ retries: 0 }).refund(chargeId, amount);", "+}"), { durationMs: 35 }));
  out.push(finishes(b.cmd(T + 38 * S, "npm run typecheck"), T + 52 * S, { status: "ok", exitCode: 0, durationMs: 14 * S, output: "> marigold-shop@3.8.0 typecheck\n> tsc --noEmit -p .\n\n" }));
  out.push(b.msg(T + 56 * S, "Done. Refunds stay on the legacy gateway with a TODO; typecheck is clean. Reporting to the coordinator."));
  return out;
}

function testsEntries(T, log) {
  const b = builder("tests");
  const out = [];
  let at = T - 46 * M;
  out.push(b.prompt(at, lines("**Task: test-suite** (from the checkout-rewrite coordinator)", "", "Run the full suite with `npm test -- --runInBand`. For any failure, report the exact assertion and the file.",
    "Fix the flaky receipt snapshot (the currency column). Do not change application code; tell me if a failure needs one."), "coordinator"));
  out.push(b.cmd(at + 6 * S, "npm ci", { output: "added 1182 packages, and audited 1183 packages in 41s\n\n214 packages are looking for funding\n  run `npm fund` for details\n\nfound 0 vulnerabilities", durationMs: 41_200 }));
  out.push(b.cmd(at + 60 * S, "npm test -- --runInBand", { exitCode: 1, status: "failed", output: log, durationMs: 212_480 }));
  out.push(b.reason(at + 5 * M, "One failure: payments-140 expects 1999 cents but the old float math gives 1998.9999. That's the bug the adapter worker is fixing, not a test problem. The snapshot is separate."));
  out.push(b.msg(at + 5 * M + 20 * S, lines("First full run: **1 failed**, the rest pass.", "", "```text", "● payments › keeps totals in cents", "  Expected: 1999", "  Received: 1998.9999999999998", "  at test/payments/payments-140.test.ts:44:26", "```", "",
    "This is the float-math bug the payments worker is replacing, so I'm leaving it and fixing the snapshot.")));
  out.push(b.edit(at + 8 * M, "test/__snapshots__/receipt.test.ts.snap", snapshotDiff(), { durationMs: 120 }));
  out.push(b.cmd(at + 9 * M, "npm test -- --runInBand test/receipt", { output: " PASS  test/receipt/receipt.test.ts (3.1s)\n    ✓ renders the receipt table (41 ms)\n    ✓ shows the currency (12 ms)\n\nTests:       2 passed, 2 total", durationMs: 4100 }));
  out.push(finishes(b.cmd(T - 25 * S, "npm test -- --runInBand test/payments"), T + 14 * S, { status: "ok", exitCode: 0, durationMs: 39 * S,
    output: " PASS  test/payments/payments-140.test.ts (2.4s)\n    ✓ keeps totals in cents (9 ms)\n    ✓ retries a declined card once (31 ms)\n\nTests:       2 passed, 2 total" }));
  out.push(b.msg(T + 16 * S, "With the adapter change, `payments-140` passes. Starting another full run to confirm."));
  return out;
}

function docsEntries(T) {
  const b = builder("docs");
  const out = [];
  const at = T - 45 * M;
  out.push(b.prompt(at, lines("**Task: docs** (from the checkout-rewrite coordinator)", "", "Add a 3.9.0 entry to `CHANGELOG.md` and a short migration note in `docs/checkout.md`: integer cents, idempotency keys, refunds unchanged."), "coordinator"));
  out.push(b.read(at + 4 * S, "CHANGELOG.md", "# Changelog\n\n## 3.8.0\n\n- Saved carts survive a sign-out.", { durationMs: 20 }));
  out.push(b.edit(at + 40 * S, "CHANGELOG.md", CHANGELOG_DIFF, { durationMs: 30 }));
  out.push(b.write(at + 90 * S, "docs/checkout.md", lines("# Checkout", "", "## Money", "", "All amounts in checkout are integer cents. Use `toCents` when reading a price and `fromCents` only to display one.", "",
    "## Charging", "", "`chargeCart(cart, { idempotencyKey })` charges through `PaymentAdapter`. The key makes a retry safe: the provider charges once per key.", "",
    "## Refunds", "", "Refunds still go through the legacy gateway in 3.9.0."), { durationMs: 25 }));
  out.push(b.msg(at + 2 * M, lines("Done. Two files:", "", "| File | Change |", "|---|---|", "| `CHANGELOG.md` | new **3.9.0** entry (4 lines) |", "| `docs/checkout.md` | new page: money, charging, refunds |", "",
    "Reported to the coordinator.")));
  out.push(b.sys(at + 2 * M + 10 * S, "Task docs marked done by the coordinator."));
  return out;
}

function lanternEntries(T) {
  const b = builder("lantern");
  const out = [];
  let at = T - 2 * H;
  out.push(b.prompt(at, "Search feels slow on the big corpus. Profile the index, find what's costing us, and try a couple of fixes. Use subagents for the legwork."));
  out.push(b.reason(at + 7 * S, "Two independent jobs: find every reader of the index format (so a format change is safe), and benchmark tokenizer settings. Both can run as subagents while I profile."));
  out.push(b.plan(at + 12 * S, [["active", "Profile a slow query"], ["pending", "Find every reader of the index format"], ["pending", "Benchmark tokenizer settings"], ["pending", "Try shorter n-grams and stop-word pruning"], ["pending", "Report numbers"]]));
  out.push(b.sub(at + 20 * S, ID.explore, { title: "Find every reader of the index format", input: "Find every place in this repository that reads the on-disk search index format (postings, block headers, the n-gram table). List files and functions. Read-only: do not change anything.",
    status: "ok", durationMs: 4 * M + 12 * S, output: "Four readers: crates/search/src/reader.rs (open_segment, read_block), crates/search/src/merge.rs (merge_segments), crates/cli/src/inspect.rs (inspect), tools/index-dump/main.rs (main)." }));
  out.push(b.cmd(at + 40 * S, "cargo run --release --bin lantern-bench -- query --corpus ./corpus --queries eval/queries.txt --profile", { durationMs: 96_000,
    output: "queries: 2,000   p50: 38.1 ms   p95: 184.3 ms   p99: 402.9 ms\n\nflame summary (self time):\n  41.2%  postings::decode_block\n  23.7%  ngram::tokenize\n  12.9%  scorer::bm25\n   8.4%  merge::union\n  13.8%  (other)" }));
  out.push(b.msg(at + 3 * M, "Profile is clear: **41%** of the time is decoding posting blocks and **24%** is tokenizing the query into n-grams. Stop-word postings are most of the decoded blocks."));
  out.push(b.sub(at + 3 * M + 20 * S, ID.bench, { title: "Benchmark tokenizer settings", input: "Benchmark the tokenizer with n-gram ranges 3..3 and 2..3, with and without stop-word pruning, warm and cold cache. Report p50/p95 and index size for each.", status: "running" }));
  out.push(b.plan(at + 3 * M + 30 * S, [["done", "Profile a slow query"], ["done", "Find every reader of the index format"], ["active", "Benchmark tokenizer settings"], ["active", "Try shorter n-grams and stop-word pruning"], ["pending", "Report numbers"]]));
  out.push(b.edit(at + 30 * M, "crates/search/src/tokenize.rs", lines("--- a/crates/search/src/tokenize.rs", "+++ b/crates/search/src/tokenize.rs", "@@ -12,7 +12,9 @@ use crate::config::IndexConfig;",
    " pub fn tokenizer(config: &IndexConfig) -> Box<dyn Tokenizer> {", "-    Box::new(NgramTokenizer::new(3..=3))", "+    // Two- and three-grams keep short identifiers (\"io\", \"db\") findable.",
    "+    let grams = if config.short_grams { 2..=3 } else { 3..=3 };", "+    Box::new(NgramTokenizer::new(grams).with_stop_words(config.stop_words.clone()))", " }"), { durationMs: 40 }));
  out.push(b.compact(at + 70 * M, "Earlier: profiled the slow query (decode 41%, tokenize 24%); explore subagent found four index readers; benchmark subagent running; tokenizer now takes short_grams and stop words behind config flags."));
  out.push(b.sys(at + 70 * M + 2 * S, "/compact"));
  out.push(b.cmd(at + 80 * M, "cargo run --release --bin lantern-index -- rebuild --short-grams --drop-stop-words ./corpus", { durationMs: 412_000, output: "segments: 64   docs: 1,204,331   size: 321 MB (was 412 MB)\nrebuilt in 6m 52s" }));
  out.push(b.cmd(at + 88 * M, "cargo run --release --bin lantern-bench -- query --corpus ./corpus --queries eval/queries.txt", { durationMs: 41_000, output: "queries: 2,000   p50: 17.2 ms   p95: 61.0 ms   p99: 133.4 ms\nrecall@10: 0.913 (baseline 0.912)" }));
  out.push(b.msg(at + 92 * M, LANTERN_REPORT));
  out.push(b.prompt(T - 9 * M, "Nice. Wait for the cold-cache numbers before the PR."));
  out.push(b.msg(T - 8 * M, "Will do. The benchmark subagent is on the cold-cache runs now; I'll fold its numbers into the table."));
  return out;
}

function exploreEntries(T) {
  const b = builder("explore");
  const out = [];
  const at = T - 2 * H + 20 * S;
  out.push(b.prompt(at, "Find every place in this repository that reads the on-disk search index format (postings, block headers, the n-gram table). List files and functions. Read-only: do not change anything.", "parent"));
  out.push(b.search(at + 5 * S, "fn (open_segment|read_block|decode_block)", "crates/search/src/reader.rs:44:pub fn open_segment(path: &Path) -> io::Result<Segment> {\ncrates/search/src/reader.rs:97:fn read_block(buf: &[u8]) -> Block {\ncrates/search/src/postings.rs:12:pub fn decode_block(block: &Block) -> Vec<u32> {", { durationMs: 230 }));
  out.push(b.search(at + 12 * S, "BlockHeader::parse", "crates/search/src/merge.rs:61:    let header = BlockHeader::parse(&bytes)?;\ncrates/cli/src/inspect.rs:23:    let header = BlockHeader::parse(&raw)?;\ntools/index-dump/main.rs:40:        let header = BlockHeader::parse(chunk).expect(\"header\");", { durationMs: 180 }));
  out.push(b.read(at + 20 * S, "tools/index-dump/main.rs", "fn main() {\n    let path = std::env::args().nth(1).expect(\"index path\");\n    for chunk in read_chunks(&path) {\n        let header = BlockHeader::parse(chunk).expect(\"header\");\n        println!(\"{header:?}\");\n    }\n}", { durationMs: 20 }));
  out.push(b.msg(at + 4 * M, lines("Four readers of the index format:", "", "| File | Function | Reads |", "|---|---|---|", "| `crates/search/src/reader.rs` | `open_segment`, `read_block` | headers, postings |",
    "| `crates/search/src/merge.rs` | `merge_segments` | headers |", "| `crates/cli/src/inspect.rs` | `inspect` | headers |", "| `tools/index-dump/main.rs` | `main` | headers |", "", "The n-gram table is only read in `reader.rs`.")));
  return out;
}

function benchEntries(T) {
  const b = builder("bench");
  const out = [];
  const at = T - 2 * H + 3 * M + 20 * S;
  out.push(b.prompt(at, "Benchmark the tokenizer with n-gram ranges 3..3 and 2..3, with and without stop-word pruning, warm and cold cache. Report p50/p95 and index size for each.", "parent"));
  out.push(b.cmd(at + 10 * S, "cargo build --release --bin lantern-bench", { durationMs: 88_000, output: "   Compiling lantern-search v0.14.2\n   Compiling lantern-bench v0.14.2\n    Finished `release` profile [optimized] target(s) in 1m 28s" }));
  for (let index = 0; index < 4; index++) {
    const grams = index % 2 ? "2..3" : "3..3";
    const stops = index >= 2 ? " --drop-stop-words" : "";
    out.push(b.cmd(at + (2 + index * 9) * M, `cargo run --release --bin lantern-bench -- tokenizer --grams ${grams}${stops} --cache warm`, { durationMs: 6 * M + index * 9000,
      output: `grams ${grams}${stops ? ", stop words dropped" : ""}, warm cache\np50: ${[38, 31, 22, 17][index]} ms   p95: ${[184, 142, 88, 61][index]} ms   index: ${[412, 388, 341, 321][index]} MB` }));
  }
  out.push(b.msg(at + 40 * M, "Warm-cache numbers are in (they match the main session's table). Cold-cache runs next: each one clears the page cache first, so they're slow."));
  out.push(finishes(b.cmd(T - 6 * M, "cargo run --release --bin lantern-bench -- tokenizer --grams 2..3 --drop-stop-words --cache cold"), T + 40 * S,
    { status: "ok", exitCode: 0, durationMs: 6 * M + 40 * S, output: "grams 2..3, stop words dropped, cold cache\np50: 29 ms   p95: 104 ms   index: 321 MB" }));
  out.push(b.msg(T + 44 * S, "Cold cache, best settings: **p50 29 ms, p95 104 ms** (baseline cold was 71 / 390 ms)."));
  return out;
}

function configEntries(T) {
  const b = builder("config");
  const out = [];
  const at = T - 14 * M;
  out.push(b.prompt(at, "Move the config loader from the hand-rolled INI parser to the toml crate. Keep the old file names working."));
  out.push(b.reason(at + 6 * S, lines("**Scoping the migration**", "", "Two loaders read `~/.copperkettle/config` today. The new one should accept `config.toml` first and fall back to the INI file with a warning.")));
  out.push(b.search(at + 12 * S, "load_config", "src/config.rs:18:pub fn load_config(path: &Path) -> Result<Config> {\nsrc/main.rs:27:    let config = load_config(&dirs.config())?;", { durationMs: 160 }));
  out.push(b.read(at + 16 * S, "src/config.rs", "pub fn load_config(path: &Path) -> Result<Config> {\n    let text = fs::read_to_string(path)?;\n    parse_ini(&text)\n}", { durationMs: 20 }));
  out.push(b.edit(at + 3 * M, "src/config.rs", lines("--- a/src/config.rs", "+++ b/src/config.rs", "@@ -15,8 +15,20 @@ use std::path::Path;",
    " pub fn load_config(path: &Path) -> Result<Config> {", "-    let text = fs::read_to_string(path)?;", "-    parse_ini(&text)",
    "+    let toml_path = path.with_file_name(\"config.toml\");", "+    if toml_path.exists() {", "+        let text = fs::read_to_string(&toml_path)?;", "+        return Ok(toml::from_str(&text)?);", "+    }",
    "+    // The old INI file still works, with a nudge to move.", "+    let text = fs::read_to_string(path)?;", "+    eprintln!(\"warning: {} is deprecated; run `copperkettle config migrate`\", path.display());", "+    parse_ini(&text)", " }"), { durationMs: 50 }));
  out.push(b.edit(at + 4 * M, "Cargo.toml", lines("--- a/Cargo.toml", "+++ b/Cargo.toml", "@@ -9,6 +9,7 @@ edition = \"2021\"", " [dependencies]", " anyhow = \"1\"", " clap = { version = \"4\", features = [\"derive\"] }",
    "+toml = \"0.8\"", " serde = { version = \"1\", features = [\"derive\"] }"), { durationMs: 20 }));
  out.push(b.msg(at + 5 * M, "The loader reads `config.toml` first and falls back to the INI file with a warning. I need to fetch the new dependency to build, which needs network access."));
  out.push({ ...b.cmd(at + 6 * M, "cargo fetch && cargo build", {}), tool: { name: "shell", kind: "command", title: "", input: "cargo fetch && cargo build", status: "running", exitCode: null, durationMs: null, output: "", diff: "", files: [] }, awaitingApproval: true });
  return out;
}

function flakyEntries(T) {
  const b = builder("flaky");
  const out = [];
  const at = T - 3 * H;
  out.push(b.prompt(at, "test/upload.spec.ts fails about one run in five on CI. Find out why and fix it."));
  out.push(b.cmd(at + 10 * S, "npx vitest run test/upload.spec.ts --repeat 20", { exitCode: 1, status: "failed", durationMs: 48_000,
    output: " ✓ test/upload.spec.ts > uploads a small file (19 runs)\n × test/upload.spec.ts > resumes after a dropped connection (4 of 20 runs failed)\n\n   AssertionError: expected 'partial' to be 'complete'\n    ❯ test/upload.spec.ts:88:31\n\n Test Files  1 failed (1)\n      Tests  4 failed | 36 passed (40)" }));
  out.push(b.reason(at + 70 * S, "The resume test races the server's chunk acknowledgement: it asserts before the last ack arrives."));
  out.push(b.edit(at + 3 * M, "test/upload.spec.ts", lines("--- a/test/upload.spec.ts", "+++ b/test/upload.spec.ts", "@@ -85,4 +85,5 @@", "   await dropConnection(server);", "   await upload.resume();",
    "-  expect(upload.state).toBe(\"complete\");", "+  await upload.settled();", "+  expect(upload.state).toBe(\"complete\");"), { durationMs: 30 }));
  out.push(b.cmd(at + 4 * M, "npx vitest run test/upload.spec.ts --repeat 50", { exitCode: 1, status: "failed", durationMs: 121_000,
    output: " × test/upload.spec.ts > resumes after a dropped connection (1 of 50 runs failed)\n\n   Error: Test timed out in 5000ms.\n    ❯ test/upload.spec.ts:86:9" }));
  out.push(b.err(at + 6 * M, "The turn stopped: the model hit its output limit while writing the next change. Nothing after this point was applied."));
  return out;
}

function notesEntries(T) {
  const b = builder("notes");
  const at = T - 3 * H - 20 * M;
  return [
    b.prompt(at, "Draft this week's release notes from the merged PRs in marigold-shop."),
    b.mcp(at + 8 * S, "mcp__github__list_pull_requests", { owner: "marigold", repo: "marigold-shop", state: "closed", since: "last week" }, "[\n  { \"number\": 481, \"title\": \"Saved carts survive sign-out\" },\n  { \"number\": 486, \"title\": \"Faster product search\" },\n  { \"number\": 490, \"title\": \"Fix tax on gift cards\" }\n]", { durationMs: 1300 }),
    b.web(at + 20 * S, "https://status.example.com/marigold/incidents", "No incidents this week.", { durationMs: 900 }),
    b.msg(at + 50 * S, lines("## This week in marigold-shop", "", "- **Saved carts survive sign-out** (#481)", "- **Faster product search** (#486): results appear about twice as fast.", "- **Gift card tax fixed** (#490)", "", "No incidents this week.")),
  ];
}

function auditEntries(T) {
  const b = builder("audit");
  const at = T - 3 * 24 * H;
  return [b.prompt(at, "List every database migration that has no down step."), b.cmd(at + 9 * S, "rg -L \"down\" migrations/", { output: "migrations/0042_add_carts.sql\nmigrations/0051_drop_sessions.sql", durationMs: 120 }),
    b.msg(at + 30 * S, "Two migrations have no down step: `0042_add_carts.sql` and `0051_drop_sessions.sql`.")];
}

function roundLeadEntries(T) {
  const b = builder("rlead");
  const at = T - 40 * M;
  return [
    b.prompt(at, "Money is rounded three different ways across checkout. Make it one rule (round half to even, in cents) everywhere. Use Orca: one coordinator, as many workers as it needs."),
    b.reason(at + 5 * S, "Seven places touch money. One worker each, a finder first, the test runner throughout."),
    b.cmd(at + 20 * S, "orca orchestration run create --name round-money --coordinator term-round-coord", { output: "Created run round-money (coordinator: term-round-coord)", durationMs: 1100 }),
    b.msg(at + 40 * S, "The run is started. The coordinator splits it into seven workers; I'll watch for its report."),
    finishes(b.cmd(T - 30 * M, "orca orchestration wait --run round-money --for report --timeout 60m"), T + 40 * M, { status: "ok", exitCode: 0, output: "Report received." }),
  ];
}

function roundCoordEntries(T) {
  const b = builder("rcoord");
  const at = T - 38 * M;
  const out = [b.prompt(at, "Coordinate **round-money**: one rule for money, round half to even in cents. Split the work by folder; the test runner checks every change.", "parent")];
  out.push(b.plan(at + 10 * S, [["done", "Find every float multiply"], ["active", "Fix totals, receipts, refunds, tax lines"], ["active", "Keep the money suite green"], ["pending", "Write the rounding rules page"]]));
  ROUND_WORKERS.forEach(([key, name], index) => out.push(b.cmd(at + (20 + index * 6) * S, `orca orchestration dispatch --run round-money --to term-${key.replace(/^round/, "round-").toLowerCase()} --task ${index + 1}`,
    { output: `Dispatched task ${index + 1} (${name}).`, durationMs: 700 + index * 40 })));
  out.push(b.msg(at + 70 * S, "Seven workers are briefed. Refunds may need a decision on partial refunds; I'll answer it."));
  return out;
}

/** A worker of the wide task: its brief, a few steps, and where it got to. */
function roundWorkerEntries(T, key, name, file, state, index) {
  const b = builder(`r${index}`);
  const at = T - 36 * M + index * 40 * S;
  const task = name.replace(/^[\w -]+: /, "");
  const out = [b.prompt(at, `**Task ${index + 1}: ${task}** (from the round-money coordinator)\n\nUse \`toCents\` and round half to even. Touch only \`${file}\`. Report the exact lines you changed.`, "coordinator")];
  out.push(b.search(at + 20 * S, "\\* (price|amount|rate)", `${file}:${12 + index}:  const value = price * rate;\n${file}:${30 + index}:  return amount * 1.0;`, { durationMs: 150 + index * 10 }));
  if (key === "roundReceipts") {
    // A message from a fellow worker, naming who sent it.
    out.push({ ...b.prompt(at + 2 * M, "Heads up: I changed `toCents()` to round half to even. Receipts should call it rather than rounding on their own.", "agent"),
      fromId: ID.roundTotals, fromName: "General-purpose: Fix rounding in totals" });
  }
  if (state !== "idle") out.push(b.edit(at + 4 * M, file, lines(`--- a/${file}`, `+++ b/${file}`, `@@ -${12 + index},2 +${12 + index},2 @@`, "-  const value = price * rate;", "+  const value = fromCents(roundHalfEven(toCents(price) * rate));", "   return value;"), { durationMs: 40 }));
  if (state === "working" && key === "roundSuite") out.push(finishes(b.cmd(T - 20 * S, "npm test -- test/money"), T + 25 * S, { status: "ok", exitCode: 0, durationMs: 45 * S, output: " PASS  test/money/round.test.ts\n    ✓ rounds half to even (4 ms)\n\nTests: 31 passed, 31 total" }));
  else if (state === "working") out.push(b.msg(at + 6 * M, `Changed \`${file}\` to round in cents. Running its tests next.`));
  if (state === "asking") out.push(b.msg(at + 6 * M, "**Question for the coordinator:** a partial refund of an odd cent: round it toward the customer, or half to even like everything else?"));
  if (state === "done") out.push(b.msg(at + 5 * M, "Found **11** float multiplies in money code: totals (3), receipts (2), refunds (2), tax lines (4). Listed them for the coordinator."));
  return out;
}

function lanternEarlierEntries(T, key, name, hoursAgo) {
  const b = builder(`le-${key}`);
  const at = T - hoursAgo * H;
  return [b.prompt(at, name.replace(/^[\w -]+: /, ""), "parent"), b.search(at + 30 * S, "tokenize", "crates/search/src/tokenize.rs:12: pub fn tokenizer(", { durationMs: 120 }),
    b.msg(at + 2 * M, `Done: ${name.replace(/^[\w -]+: /, "").toLowerCase()}.`)];
}

// ---- The demo service ----

/** The demo's answers to every client call; `clock` is injectable for tests. */
export function createDemo({ clock = () => Date.now(), latency = true } = {}) {
  const T = clock();
  const log = bigTestLog();
  const state = { answered: new Map(), dismissed: new Set(), sent: [], joined: new Map(), approval: "pending" };
  const transcripts = {
    [ID.lead]: leadEntries(T), [ID.coord]: coordEntries(T), [ID.pay]: paymentsEntries(T), [ID.tests]: testsEntries(T, log), [ID.docs]: docsEntries(T),
    [ID.lantern]: lanternEntries(T), [ID.explore]: exploreEntries(T), [ID.bench]: benchEntries(T), [ID.config]: configEntries(T), [ID.flaky]: flakyEntries(T),
    [ID.notes]: notesEntries(T), [ID.fresh]: [], [ID.audit]: auditEntries(T),
    [ID.roundLead]: roundLeadEntries(T), [ID.roundCoord]: roundCoordEntries(T),
    ...Object.fromEntries(ROUND_WORKERS.map(([key, name, , file, state], index) => [ID[key], roundWorkerEntries(T, key, name, file, state, index)])),
    [ID.lanternRfc]: lanternEarlierEntries(T, "rfc", "General-purpose: Draft the tokenizer RFC", 20),
    [ID.lanternParser]: lanternEarlierEntries(T, "parser", "Explore: Map the query parser", 19),
    [ID.lanternCold]: lanternEarlierEntries(T, "cold", "General-purpose: Profile cold starts", 5),
    [ID.lanternStops]: lanternEarlierEntries(T, "stops", "Explore: Check the stop-word list", 0.7),
  };
  const keepalive = (now) => {
    // The tests worker keeps running suites and the coordinator keeps checking in, so the demo never goes still.
    const extra = { [ID.tests]: [], [ID.coord]: [] };
    const begin = T + 70 * S;
    for (let slot = 0; begin + slot * 20 * S <= now && slot < 400; slot++) {
      const at = begin + slot * 20 * S;
      const suite = ["cart", "pricing", "payments", "refunds", "shipping", "tax", "coupons", "receipts"][slot % 8];
      extra[ID.tests].push({ id: `tests-live-${slot}`, at, kind: "tool", doneAt: at + 9 * S,
        final: { status: "ok", exitCode: 0, durationMs: 9 * S, output: ` PASS  test/${suite}/${suite}.test.ts (${(slot % 5) + 2}.${slot % 9}s)\n    ✓ ${suite} keeps totals in cents (${slot % 30 + 3} ms)\n\nTests:       ${12 + (slot % 7)} passed, ${12 + (slot % 7)} total` },
        tool: { name: "shell", kind: "command", title: "", input: `npm test -- --runInBand test/${suite}`, status: "running", exitCode: null, durationMs: null, output: "", diff: "", files: [] } });
      if (slot % 3 === 2) extra[ID.coord].push({ id: `coord-live-${slot}`, at: at + 11 * S, kind: "message", text: `Checked in on the suite: **${suite}** passes. ${slot % 2 ? "Still waiting on the full run." : "Payments worker is idle; adapter merged locally."}` });
    }
    return extra;
  };

  /** Entries of one agent as they stand at `now`: revealed, finished, plus replies sent from the page. */
  const visible = (id, now) => {
    const base = transcripts[id];
    if (!base) return null;
    const live = keepalive(now)[id] || [];
    const sent = state.sent.filter((item) => item.id === id).map((item) => item.entry);
    return [...base, ...live, ...sent].filter((entry) => entry.at <= now).map((entry) => {
      let shown = entry;
      if (entry.doneAt && entry.doneAt <= now) shown = { ...entry, tool: { ...entry.tool, ...entry.final } };
      if (entry.awaitingApproval && state.approval !== "pending") {
        shown = state.approval === "accept"
          ? { ...entry, tool: { ...entry.tool, status: now > state.approvedAt + 6 * S ? "ok" : "running", exitCode: now > state.approvedAt + 6 * S ? 0 : null, durationMs: now > state.approvedAt + 6 * S ? 6200 : null,
            output: now > state.approvedAt + 6 * S ? "    Updating crates.io index\n  Downloaded toml v0.8.19\n   Compiling toml v0.8.19\n   Compiling copperkettle v0.9.0\n    Finished `dev` profile in 6.1s" : "" } }
          : { ...entry, tool: { ...entry.tool, status: "denied", output: "You declined this command." } };
      }
      const changedAt = Math.max(entry.at, entry.doneAt && entry.doneAt <= now ? entry.doneAt : 0, entry.awaitingApproval && state.approvedAt ? Math.min(now, state.approvedAt + 6 * S) : 0);
      const { doneAt, final, awaitingApproval, ...clean } = shown;
      return { ...clean, changedAt };
    });
  };

  const agent = (id, fields) => ({ id, updatedAt: T, ...fields });

  const tasks = (hours = 24) => {
    const now = clock();
    const answered = now >= T + 19 * S;
    const testsRunning = true;
    const coordQuiet = now < T + 18 * S;
    const configAsk = state.approval === "pending" && !state.dismissed.has(`${ID.config}:ask-cargo`)
      ? { kind: "approval", text: "Allow Codex to run this command? It needs network access to download the toml crate.", command: "cargo fetch && cargo build", tool: "shell",
        at: T - 8 * M, answerHere: "respond", requestId: "17", key: "ask-cargo" } : null;
    const all = [
      {
        id: "task-checkout", title: "Checkout rewrite", project: "marigold-shop", startedAt: T - 7 * H, updatedAt: now - 2 * S,
        agents: [
          agent(ID.lead, { source: "codex", name: "Plan the checkout rewrite", model: MODELS.sol, role: "lead", depth: 0, status: "working", attention: "working", cwd: "C:\\code\\marigold-shop",
            now: { kind: "command", title: "Waiting for the coordinator's report", detail: "orca orchestration wait --run checkout-rewrite --for report", startedAt: T - 40 * S }, updatedAt: now - 5 * S, startedAt: T - 7 * H }),
          agent(ID.coord, { source: "orca", name: "Coordinator", model: MODELS.opus, role: "coordinator", parentId: ID.lead, depth: 1, status: "working", attention: "working", terminal: "term-coordinator",
            now: coordQuiet ? { kind: "think", title: "Deciding the payments worker's question", startedAt: T - 2 * M } : { kind: "message", title: "Answered the payments worker", startedAt: T + 21 * S, done: true },
            progress: { done: answered ? 5 : 4, total: 7, current: answered ? "Review the adapter diff" : "Answer worker questions" }, updatedAt: now - 3 * S, startedAt: T - 50 * M }),
          agent(ID.pay, { source: "orca", name: "Payments adapter", model: MODELS.sonnet, role: "worker", parentId: ID.coord, depth: 2, status: "working", attention: "working", terminal: "term-payments",
            waitingOn: answered ? null : { on: ID.coord, kind: "question", text: "Should refunds go through the new adapter too, or stay on the legacy path for this release?", at: T - 3 * M },
            now: answered ? { kind: "edit", title: "Editing src/checkout/payments.ts", startedAt: T + 30 * S } : { kind: "ask", title: "Asked the coordinator about refunds", startedAt: T - 3 * M },
            updatedAt: now - 8 * S, startedAt: T - 47 * M }),
          agent(ID.tests, { source: "orca", name: "Test runner", model: MODELS.opus, role: "worker", parentId: ID.coord, depth: 2, status: testsRunning ? "working" : "idle", attention: "working", terminal: "term-tests",
            now: { kind: "command", title: "Running npm test -- --runInBand", detail: "npm test -- --runInBand test/payments", startedAt: T - 25 * S }, updatedAt: now - 1 * S, startedAt: T - 46 * M }),
          agent(ID.docs, { source: "orca", name: "Docs and changelog", model: MODELS.codex, role: "worker", parentId: ID.coord, depth: 2, status: "done", attention: "quiet", terminal: "term-docs",
            now: { kind: "write", title: "Wrote docs/checkout.md", startedAt: T - 43 * M, done: true }, updatedAt: T - 43 * M, startedAt: T - 45 * M }),
        ],
        links: [{ from: ID.lead, to: ID.coord, kind: "drives", at: T - 50 * M }, { from: ID.coord, to: ID.pay, kind: "dispatched", at: T - 49 * M },
          { from: ID.coord, to: ID.tests, kind: "dispatched", at: T - 49 * M }, { from: ID.coord, to: ID.docs, kind: "dispatched", at: T - 49 * M },
          ...(answered ? [] : [{ from: ID.pay, to: ID.coord, kind: "asked", at: T - 3 * M }])],
      },
      {
        id: "task-config", title: "Migrate the config loader", project: "copperkettle-cli", startedAt: T - 14 * M, updatedAt: T - 8 * M,
        agents: [agent(ID.config, { source: "codex", name: "Migrate the config loader", model: { ...MODELS.sol, effort: "medium" }, role: "solo", depth: 0,
          status: configAsk ? "waiting" : "working", attention: configAsk ? "needs" : "working", ask: configAsk, cwd: "C:\\code\\copperkettle-cli",
          now: configAsk ? { kind: "ask", title: "Waiting for your approval", startedAt: T - 8 * M } : { kind: "command", title: "Running cargo fetch && cargo build", startedAt: state.approvedAt || T }, updatedAt: T - 8 * M, startedAt: T - 14 * M })],
        links: [],
      },
      {
        id: "task-lantern", title: "Tune the search index", project: "lantern-docs", startedAt: T - 2 * H, updatedAt: now - 4 * S,
        agents: [
          agent(ID.lantern, { source: "claude", name: "Tune the search index", model: MODELS.opus, role: "lead", depth: 0, status: "working", attention: "working", cwd: "C:\\code\\lantern-docs",
            now: { kind: "agent", title: "Waiting for the benchmark subagent", startedAt: T - 8 * M }, progress: { done: 3, total: 5, current: "Benchmark tokenizer settings" }, updatedAt: now - 30 * S, startedAt: T - 2 * H }),
          agent(ID.explore, { source: "claude", name: "Find every reader of the index format", model: MODELS.haiku, role: "subagent", parentId: ID.lantern, depth: 1, status: "done", attention: "quiet",
            now: { kind: "message", title: "Reported four readers", startedAt: T - 2 * H + 4 * M, done: true }, updatedAt: T - 2 * H + 4 * M, startedAt: T - 2 * H }),
          agent(ID.bench, { source: "claude", name: "Benchmark tokenizer settings", model: MODELS.sonnet, role: "subagent", parentId: ID.lantern, depth: 1, status: now > T + 44 * S ? "done" : "working", attention: "working",
            now: now > T + 44 * S ? { kind: "message", title: "Reported cold-cache numbers", startedAt: T + 44 * S, done: true } : { kind: "command", title: "Running the cold-cache benchmark", detail: "lantern-bench tokenizer --cache cold", startedAt: T - 6 * M },
            updatedAt: now - 6 * S, startedAt: T - 2 * H + 3 * M }),
          // Earlier subagents: two the server marks stale, one finished hours ago, one a little while ago.
          ...[["lanternRfc", "General-purpose: Draft the tokenizer RFC", 20, true], ["lanternParser", "Explore: Map the query parser", 19, true],
            ["lanternCold", "General-purpose: Profile cold starts", 5, false], ["lanternStops", "Explore: Check the stop-word list", 0.7, false]]
            .map(([key, name, hoursAgo, stale]) => agent(ID[key], { source: "claude", name, model: MODELS.haiku, role: "subagent", parentId: ID.lantern, depth: 1, status: "done", attention: "quiet",
              ...(stale ? { stale: true } : {}), now: { kind: "message", title: "Reported back", startedAt: T - hoursAgo * H + 2 * M, done: true },
              updatedAt: T - hoursAgo * H + 2 * M, startedAt: T - hoursAgo * H })),
        ],
        links: [{ from: ID.lantern, to: ID.explore, kind: "spawned", at: T - 2 * H + 20 * S }, { from: ID.lantern, to: ID.bench, kind: "spawned", at: T - 2 * H + 3 * M },
          ...["lanternRfc", "lanternParser", "lanternCold", "lanternStops"].map((key) => ({ from: ID.lantern, to: ID[key], kind: "spawned" }))],
      },
      {
        id: "task-round", title: "Round money consistently", project: "copperkettle-cli", startedAt: T - 40 * M, updatedAt: now - 3 * S,
        agents: [
          agent(ID.roundLead, { source: "codex", name: "Round money consistently", model: MODELS.sol, role: "lead", depth: 0, status: "working", attention: "working",
            now: { kind: "command", title: "Waiting for the coordinator's report", startedAt: T - 30 * M }, updatedAt: now - 20 * S, startedAt: T - 40 * M }),
          agent(ID.roundCoord, { source: "orca", name: "Rounding coordinator", model: MODELS.opus, role: "coordinator", parentId: ID.roundLead, depth: 1, status: "working", attention: "working",
            now: { kind: "think", title: "Watching seven workers", startedAt: T - 5 * M }, progress: { done: 1, total: 4, current: "Fix totals, receipts, refunds, tax lines" }, updatedAt: now - 9 * S, startedAt: T - 38 * M }),
          ...ROUND_WORKERS.map(([key, name, model, file, state], index) => agent(ID[key], { source: "orca", name, model: MODELS[model], role: "worker", parentId: ID.roundCoord, depth: 2,
            status: state === "asking" || state === "working" ? "working" : state === "done" ? "done" : "idle", attention: state === "done" || state === "idle" ? "quiet" : "working",
            ...(state === "asking" ? { waitingOn: { on: ID.roundCoord, text: "A partial refund of an odd cent: round toward the customer, or half to even?", at: T - 4 * M } } : {}),
            now: state === "done" ? { kind: "message", title: "Listed 11 float multiplies", startedAt: T - 30 * M, done: true }
              : state === "idle" ? null : key === "roundSuite" ? { kind: "command", title: "Running npm test -- test/money", startedAt: T - 20 * S }
                : { kind: "edit", title: `Editing ${file}`, startedAt: T - (index + 1) * 40 * S },
            updatedAt: state === "done" ? T - 30 * M : state === "idle" ? T - 34 * M : now - (index + 2) * S, startedAt: T - 36 * M + index * 40 * S })),
        ],
        links: [{ from: ID.roundLead, to: ID.roundCoord, kind: "drives", at: T - 38 * M },
          ...ROUND_WORKERS.map(([key], index) => ({ from: ID.roundCoord, to: ID[key], kind: "dispatched", at: T - 37 * M + index * 6 * S })),
          { from: ID.roundRefunds, to: ID.roundCoord, kind: "asked", at: T - 4 * M, waiting: true }],
      },
      {
        id: "task-fresh", title: "Rename the CLI flags", project: "copperkettle-cli", startedAt: T - 20 * S, updatedAt: T - 20 * S,
        agents: [agent(ID.fresh, { source: "claude", name: "Rename the CLI flags", model: MODELS.sonnet, role: "solo", status: "working", attention: "working",
          now: { kind: "think", title: "Thinking", startedAt: T - 20 * S }, updatedAt: T - 20 * S, startedAt: T - 20 * S })],
        links: [],
      },
      {
        id: "task-flaky", title: "Fix the flaky upload test", project: "lantern-docs", startedAt: T - 3 * H, updatedAt: T - 2 * H - 54 * M,
        agents: [agent(ID.flaky, { source: "codex", name: "Fix the flaky upload test", model: MODELS.codex, role: "solo", status: "failed", attention: "failed",
          now: { kind: "command", title: "Ran npx vitest run test/upload.spec.ts --repeat 50", startedAt: T - 2 * H - 56 * M, done: true }, updatedAt: T - 2 * H - 54 * M, startedAt: T - 3 * H })],
        links: [],
      },
      {
        id: "task-notes", title: "Weekly release notes", project: "marigold-shop", startedAt: T - 3 * H - 20 * M, updatedAt: T - 3 * H - 19 * M,
        agents: [agent(ID.notes, { source: "claude", name: "Weekly release notes", model: MODELS.sonnet, role: "solo", status: "done", attention: "quiet",
          now: { kind: "message", title: "Wrote the release notes", startedAt: T - 3 * H - 19 * M, done: true }, updatedAt: T - 3 * H - 19 * M, startedAt: T - 3 * H - 20 * M })],
        links: [],
      },
      {
        id: "task-theme", title: "Theme tokens spike", project: "marigold-shop", startedAt: T - 6 * H, updatedAt: T - 5 * H,
        agents: [agent(ID.theme, { source: "claude", name: "Theme tokens spike", model: MODELS.opus, role: "solo", status: "idle", attention: "quiet", updatedAt: T - 5 * H, startedAt: T - 6 * H })],
        links: [],
      },
      {
        id: "task-audit", title: "Audit old migrations", project: "copperkettle-cli", startedAt: T - 3 * 24 * H, updatedAt: T - 3 * 24 * H + 30 * S,
        agents: [agent(ID.audit, { source: "codex", name: "Audit old migrations", model: MODELS.codex, role: "solo", status: "done", attention: "quiet", updatedAt: T - 3 * 24 * H + 30 * S, startedAt: T - 3 * 24 * H })],
        links: [],
      },
    ];
    // A chat joined to a task from the page moves into it.
    for (const [party, chat] of state.joined) {
      const from = all.find((task) => task.agents.some((item) => item.id === party));
      const to = all.find((task) => task.agents.some((item) => item.id === chat));
      if (!from || !to || from === to) continue;
      for (const moved of from.agents) to.agents.push({ ...moved, role: "worker", parentId: chat, depth: 1 });
      to.links.push({ from: chat, to: party, kind: "drives", at: now });
      all.splice(all.indexOf(from), 1);
    }
    const cutoff = now - hours * H;
    return delay({
      tasks: all.filter((task) => task.updatedAt >= cutoff),
      sources: {
        // A cold start: Codex is still listing its chats for the first 25 seconds.
        codex: now < T + 25 * S ? { state: "partial", say: "Codex is still listing its chats; this is the last list." } : { state: "ok", say: "Reading 14 Codex chats from the last 24 hours." },
        claude: { state: "ok", say: "Recording Claude Code activity on this computer." },
        orca: { state: "unavailable", say: "Orca is running, but its command line can't reach it. Restart Orca to see its workers live; workers it already saw stay grouped." },
      },
      window: { hours },
      checkedAt: now,
    });
  };

  const transcript = (id, { after = "", before = "", limit = 200 } = {}) => {
    const now = clock();
    if (id === ID.theme) return delay(null, new Error("This session's transcript file has moved or been deleted. It comes back if the session writes again."));
    const all = visible(id, now);
    if (!all) return delay(null, Object.assign(new Error("That agent is not in view any more."), { status: 404 }));
    const strip = ({ changedAt, ...entry }) => entry;
    if (after.startsWith("t:")) {
      const since = Number(after.slice(2));
      const fresh = all.filter((entry) => entry.changedAt > since);
      return delay({ entries: fresh.map(strip), cursor: { first: "", last: `t:${now}` }, hasOlder: false, live: true, checkedAt: now });
    }
    let end = all.length;
    if (before.startsWith("i:")) end = Math.max(0, Math.min(all.length, Number(before.slice(2))));
    const start = Math.max(0, end - limit);
    return delay({ entries: all.slice(start, end).map(strip), cursor: { first: `i:${start}`, last: `t:${now}` }, hasOlder: start > 0, live: true, checkedAt: now });
  };

  function delay(value, error) {
    if (!latency) return error ? Promise.reject(error) : Promise.resolve(structuredClone(value));
    return new Promise((resolve, reject) => setTimeout(() => (error ? reject(error) : resolve(structuredClone(value))), 80 + Math.random() * 220));
  }

  return {
    ids: ID,
    tasks,
    transcript,
    requests: async (threadId) => (threadId === ID.config && state.approval === "pending"
      ? [{ id: 17, method: "item/commandExecution/requestApproval", params: { threadId, command: "cargo fetch && cargo build", reason: "Needs network access to download the toml crate." } }] : []),
    respond: async (threadId, requestId, answer) => {
      if (threadId !== ID.config || state.approval !== "pending") throw Object.assign(new Error("That decision is no longer pending."), { status: 404 });
      state.approval = answer?.decision === "accept" ? "accept" : "decline";
      state.approvedAt = clock();
      return { answered: true };
    },
    message: async (id, words) => {
      const now = clock();
      if (!transcripts[id]) throw Object.assign(new Error("That agent is not in view any more."), { status: 404 });
      state.sent.push({ id, entry: { id: `sent-${state.sent.length + 1}`, at: now, kind: "prompt", from: "you", text: words } });
      return { sent: true };
    },
    dismiss: async (id, key) => { state.dismissed.add(`${id}:${key}`); return { id, key }; },
    open: async (id) => ({ opened: true, demo: true, id }),
    join: async (party, chat) => {
      if (chat === null || chat === "") state.joined.delete(party);
      else state.joined.set(party, chat);
      return { manualLinks: Object.fromEntries(state.joined) };
    },
  };
}
