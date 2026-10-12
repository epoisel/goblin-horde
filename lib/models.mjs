/**
 * Which model an agent runs, in the short words a goblin's badge shows.
 *
 * Sources report raw ids ("claude-opus-5-5", "gpt-5.6-sol", "o3"). Every actor carries the same
 * small object, { id, label, family, effort }, so the widget and the browser viewer label it and
 * pick its goblin tribe without knowing any source's id format. Unknown ids keep a cleaned id as
 * their label and the "other" family.
 */

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const CLAUDE_TIERS = new Set(["opus", "sonnet", "haiku", "fable"]);
// Cloud ids such as Bedrock's "us.anthropic.claude-sonnet-4-5-20250929-v1:0".
const VENDOR_PREFIX = /^((anthropic|us|eu|apac|global)\.)+/;

/** A model id that is safe to keep and show, or "". */
export function cleanModelId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_MODEL.test(text) ? text : "";
}

/** "claude" | "openai" | "other", from the id first and the source's provider name second. */
export function modelFamily(id, provider = "") {
  const value = String(id || "").toLowerCase().replace(VENDOR_PREFIX, "");
  if (/(^|[/.:])claude\b|^claude-|^(opus|sonnet|haiku|fable)\b/.test(value)) return "claude";
  if (/^(gpt|o\d|codex|chatgpt)\b|[/.:](gpt|o\d|codex)\b/.test(value)) return "openai";
  const vendor = String(provider || "").toLowerCase();
  if (vendor === "anthropic") return "claude";
  if (vendor === "openai") return "openai";
  return "other";
}

const title = (word) => (word ? word[0].toUpperCase() + word.slice(1) : "");

/**
 * A short human label: "Opus 5.5", "Sonnet 4.5", "Haiku 3.5", "GPT-5.6 Sol", "GPT-5 Codex", "o3".
 * Date stamps and region or vendor prefixes are dropped; the [1m] context marker stays as "1M".
 */
export function modelLabel(id) {
  const raw = cleanModelId(id);
  if (!raw) return "";
  let value = raw.toLowerCase().replace(VENDOR_PREFIX, "").replace(/^[a-z]+\//, "");
  const longContext = /\[1m\]$/.test(value);
  value = value.replace(/\[1m\]$/, "").replace(/-v\d+(:\d+)?$/, "").replace(/[-@]\d{8}$/, "").replace(/-latest$/, "");
  const suffix = longContext ? " 1M" : "";
  // claude-opus-5-5, claude-sonnet-4-5, claude-opus-4-1
  let match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(value);
  if (match && CLAUDE_TIERS.has(match[1])) return `${title(match[1])} ${match[2]}${match[3] ? `.${match[3]}` : ""}${suffix}`;
  // claude-3-5-haiku, claude-3-opus
  match = /^claude-(\d+)(?:-(\d))?-([a-z]+)$/.exec(value);
  if (match && CLAUDE_TIERS.has(match[3])) return `${title(match[3])} ${match[1]}${match[2] ? `.${match[2]}` : ""}${suffix}`;
  if (/^(opus|sonnet|haiku|fable)$/.test(value)) return `${title(value)}${suffix}`;
  // gpt-5.6-sol, gpt-5-codex, gpt-4o-mini
  match = /^gpt-([0-9][0-9a-z.]*)((?:-[a-z0-9]+)*)$/.exec(value);
  if (match) {
    const words = match[2].split("-").filter(Boolean).map((word) => (word === "mini" || word === "nano" ? word : title(word)));
    return [`GPT-${match[1]}`, ...words].join(" ") + suffix;
  }
  if (/^o\d[a-z0-9-]*$/.test(value)) return value.replace(/-/g, " ");
  return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
}

/** The model object every actor carries, or null when the source did not say. */
export function describeModel(id, { provider = "", effort = "" } = {}) {
  const clean = cleanModelId(id);
  if (!clean) return null;
  const level = String(effort || "").toLowerCase();
  return { id: clean, label: modelLabel(clean), family: modelFamily(clean, provider), ...(EFFORTS.has(level) ? { effort: level } : {}) };
}
