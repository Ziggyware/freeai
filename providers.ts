// ═══════════════════════════════════════════════════════════════════════════
//  PROVIDERS — the ONE place a provider is described.
//
//  This replaces four files that had drifted into two competing truths:
//  catalog.ts + catalog-free.ts + catalog-paid.ts described 25 vendors that
//  nothing imported, while inference-provider.ts described the 3 vendors the
//  router actually used. Whichever one you edited, the other one disagreed.
//
//  A row is a vendor. A vendor becomes one INSTANCE per API key found in the
//  environment (KEY, KEY1 … KEY9, and any of those may hold "k1,k2,k3"), so a
//  vendor with five keys is five independently-cooled instances named
//  `groq`, `groq#1` … `groq#4`.
//
//  Everything here is a plain fact about the vendor — where it lives, what it
//  serves, how big a prompt it takes, how fast it answers. Nothing here knows
//  about the request. Ranking, cooldowns and fallback live in router.ts.
// ═══════════════════════════════════════════════════════════════════════════

export type Tag = "coder" | "reasoning" | "fast" | "long" | "vision";

/** Why this vendor is available at all. It decides RANK, never eligibility:
 *  a vendor with no key is not instantiated whatever its tier.
 *   free   — a recurring free tier, no card. Tried first.
 *   credit — a finite grant or trial balance (Cerebras' $5/30d, DeepInfra's credit).
 *   paid   — metered per token. Last resort, and only ever reached when every
 *            free and credit instance has failed or is cooling down. */
export type Tier = "free" | "credit" | "paid";

export type Vendor = {
  /** Stable id. Used in `model: "groq"`, in OMNI_DISABLE, and as the key a
   *  bound model is saved under. Renaming one breaks saved bindings, so don't. */
  vendor: string;
  /** OpenAI-compatible base URL. `${ENV}` is interpolated from the environment
   *  (Cloudflare needs the account id in the path). */
  base: string;
  /** Env var holding the key. `KEY`, `KEY1` … `KEY9` are all read; null ⇒ keyless. */
  keyEnv: string | null;
  /** Ordered candidate model ids. `models[0]` is the default; the rest are the
   *  fallback chain used when upstream says a model does not exist. Keep them
   *  the SAME KIND of model: a chain whose members disagree about what they are
   *  produces answers that vary by which provider happened to be up. */
  models: string[];
  tier?: Tier; // default "free"
  tags?: Tag[];
  /** Regex source (case-insensitive) for live `/models` discovery: when every id
   *  in `models` is dead upstream, the first live id matching this replaces it.
   *  Free rosters rotate — OpenRouter's entire `:free` list changed inside a
   *  quarter — so a catalog that cannot heal itself is a catalog that rots. */
  prefer?: string;
  /** Extra headers this vendor wants (OpenRouter-style attribution, betas). */
  headers?: Record<string, string>;
  /** Measured/estimated output tokens per second. Drives `fast` ranking and the
   *  ETA a deadline is checked against. Default 60. */
  tps?: number;
  /** Typical ms to first token. Default 1500. */
  ttft?: number;
  /** Largest prompt (tokens) this vendor accepts per request. A prompt above it
   *  SKIPS the vendor instead of spending an attempt on a guaranteed 413. */
  maxIn?: number;
  /** Ceiling for `max_tokens`. Free tiers meter prompt + max_tokens together,
   *  so asking a small vendor for 16k output is a self-inflicted 429. */
  maxOut?: number;
  /** Tokens per minute this vendor meters. Treated as ONE request's share of
   *  the minute — a single call that asks for the whole budget leaves nothing
   *  for the retry. Tightens `maxOut` as the prompt grows. */
  tpm?: number;
  /** Manual rank override. Defaults to the tier band, ties broken by the order
   *  rows are written below — so adding a vendor is one line, not a renumber. */
  priority?: number;
};

/** Rank bands. A `credit` vendor outranks every `paid` one and loses to every
 *  `free` one, whatever the models' quality scores: spending money is a decision
 *  the router should not make while a free tier is still answering. */
const TIER_RANK: Record<Tier, number> = { free: 0, credit: 20, paid: 40 };

// ───────────────────────────────────────────────────────────────────────────
//  THE CATALOG
//
//  Free tiers first (recurring, no card), then finite credit, then metered.
//  Order within a band is the tie-break, so the fastest/most dependable go first.
//  Verified against each vendor's published free tier 2026-09/10.
// ───────────────────────────────────────────────────────────────────────────
const VENDORS: Vendor[] = [
  // ── FREE, high throughput ────────────────────────────────────────────────
  // Groq retired llama-3.3-70b and llama-3.1-8b from the free plan on
  // 2026-08-16, so `prefer` no longer reaches for llama. Free tier is
  // 30 RPM / 1k RPD / ~6k TPM per model: the TPM is why `tpm` is declared,
  // and the RPD is why per-key slots matter more here than anywhere else.
  { vendor: "groq", base: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", tier: "free",
    tags: ["fast", "reasoning"], tps: 400, ttft: 600, maxIn: 6500, maxOut: 5500, tpm: 6000,
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"], prefer: "gpt-oss|qwen" },
  // Cerebras moved from a card-free tier to a finite $5/30-day trial, so it is
  // `credit`, not `free`: still the fastest silicon in the roster, but a balance
  // that runs out is not a daily driver.
  { vendor: "cerebras", base: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", tier: "credit",
    tags: ["fast"], tps: 1200, ttft: 400, maxOut: 8000,
    models: ["qwen-3.8-27b", "gpt-oss-120b", "gemma-4-31b"], prefer: "gpt-oss|qwen|gemma" },
  { vendor: "sambanova", base: "https://api.sambanova.ai/v1", keyEnv: "SAMBANOVA_API_KEY", tier: "free",
    tags: ["fast", "reasoning"], tps: 300, ttft: 900,
    models: ["MiniMax-M3", "DeepSeek-V3.2", "gpt-oss-120b", "Meta-Llama-3.3-70B-Instruct"], prefer: "minimax|deepseek|gpt-oss|llama" },
  // Gemini's free tier is the most generous daily allowance of any no-card
  // provider and the only one here that takes images, so it carries `vision`.
  { vendor: "gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", tier: "free",
    tags: ["fast", "long", "vision"], tps: 150, ttft: 1200,
    models: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"], prefer: "flash" },
  // The only vendor whose BASE URL needs an env var as well as its key. A
  // missing CF_ACCOUNT_ID is reported as a key issue on the instance rather than
  // surfacing as an "Invalid URL" network error three layers away from its cause.
  { vendor: "cloudflare", base: "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1", keyEnv: "CLOUDFLARE_API_KEY", tier: "free",
    tags: ["fast"], tps: 100, ttft: 800,
    models: ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8"], prefer: "gpt-oss|llama-3.3|qwen" },
  // ── FREE, aggregator / router tiers ──────────────────────────────────────
  // OpenRouter: one key, a rotating roster of `:free` models, 20 RPM and
  // 50 RPD (1,000 RPD once the account has ever bought $10). The daily cap is
  // low enough that it is a width provider, not a depth one — which is exactly
  // what per-model cooldowns and vendor interleaving are for. Ordered by
  // throughput on the free tier: the 550B model times out inside a 50 s turn.
  { vendor: "openrouter", base: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", tier: "free",
    tags: ["coder", "reasoning", "long", "vision"], tps: 30, ttft: 4000,
    headers: { "HTTP-Referer": "https://val.town", "X-Title": "Ziggyware-OmniRouter" },
    models: [
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3.5-lightning:free",
      "thinkingmachines/inkling:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ], prefer: "super|gemma|lightning|:free" },
  // Hugging Face routes one token across ~18 partner providers. The free grant
  // is $0.10/month, so it is thin — but it is a SECOND router behind one key,
  // which makes it disproportionately useful when every direct tier is capped.
  { vendor: "huggingface", base: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN", tier: "free",
    tags: ["coder", "reasoning", "long"], tps: 50, ttft: 2500,
    models: [
      "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K3", "zai-org/GLM-5.3", "deepseek-ai/DeepSeek-V4-Flash",
      "Qwen/Qwen3-Coder-Next", "Qwen/Qwen3.8-27B", "openai/gpt-oss-120b", "zai-org/GLM-5.3-Flash",
    ], prefer: "deepseek|kimi|glm|qwen|gpt-oss" },
  { vendor: "mistral", base: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", tier: "free",
    tags: ["coder"], tps: 80, ttft: 1000,
    models: ["mistral-small-latest", "ministral-14b-latest", "ministral-8b-latest", "devstral-small-latest"], prefer: "mistral-small|ministral|devstral" },
  { vendor: "cohere", base: "https://api.cohere.ai/compatibility/v1", keyEnv: "COHERE_API_KEY", tier: "free",
    tags: ["long"], tps: 60, ttft: 1500,
    models: ["command-a-03-2025", "command-r7b-12-2024", "command-r-plus"], prefer: "command" },
  { vendor: "zai", base: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZAI_API_KEY", tier: "free",
    tags: ["coder"], tps: 70, ttft: 1400,
    models: ["glm-5.3-flash", "glm-4.5-air", "glm-5-turbo"], prefer: "flash|air|turbo" },
  // Vendor id keeps the `_nim` suffix on purpose: `nvidia` is a prefix of
  // OpenRouter's `nvidia/…:free` ids, and a vendor named `nvidia` would swallow
  // `model: "nvidia/nemotron-3-super-120b-a12b:free"` as a vendor pin instead of
  // letting it resolve to the OpenRouter row that actually serves it.
  { vendor: "nvidia_nim", base: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY", tier: "free",
    tags: ["reasoning", "vision"], tps: 40, ttft: 2000,
    models: ["nvidia/llama-3.1-nemotron-51b-instruct", "mistralai/mistral-nemotron", "meta/llama-3.2-90b-vision-instruct"], prefer: "nemotron|mistral-nemotron|llama-3.2-90b" },
  { vendor: "dashscope", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyEnv: "DASHSCOPE_API_KEY", tier: "free",
    tags: ["coder", "long"], tps: 70, ttft: 1600,
    models: ["qwen-plus", "qwen3-coder-plus", "qwen-turbo"], prefer: "qwen" },
  { vendor: "siliconflow", base: "https://api.siliconflow.cn/v1", keyEnv: "SILICONFLOW_API_KEY", tier: "free",
    tps: 60, ttft: 1800, models: ["Qwen/Qwen3-8B", "THUDM/GLM-4-9B-0414"], prefer: "qwen3|glm" },
  { vendor: "ovh", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", keyEnv: "OVH_AI_ENDPOINTS_ACCESS_TOKEN", tier: "free",
    tps: 55, ttft: 1800, models: ["Meta-Llama-3_3-70B-Instruct", "gpt-oss-120b", "Qwen3-32B"], prefer: "llama|gpt-oss|qwen" },
  { vendor: "chutes", base: "https://llm.chutes.ai/v1", keyEnv: "CHUTES_API_KEY", tier: "free",
    tps: 60, ttft: 1800, models: ["openai/gpt-oss-120b", "Qwen/Qwen3-235B-A22B-Instruct-2507"], prefer: "gpt-oss|qwen" },
  { vendor: "novita", base: "https://api.novita.ai/v3/openai", keyEnv: "NOVITA_API_KEY", tier: "free",
    tps: 55, ttft: 2000, models: ["openai/gpt-oss-120b", "meta-llama/llama-3.3-70b-instruct"], prefer: "gpt-oss|llama-3.3" },
  { vendor: "hyperbolic", base: "https://api.hyperbolic.xyz/v1", keyEnv: "HYPERBOLIC_API_KEY", tier: "free",
    tps: 50, ttft: 2200, models: ["openai/gpt-oss-120b", "meta-llama/Llama-3.3-70B-Instruct"], prefer: "gpt-oss|llama-3.3" },
  { vendor: "scaleway", base: "https://api.scaleway.ai/v1", keyEnv: "SCW_SECRET_KEY", tier: "free",
    tps: 55, ttft: 2000, models: ["gpt-oss-120b", "llama-3.3-70b-instruct"], prefer: "gpt-oss|llama" },
  { vendor: "featherless", base: "https://api.featherless.ai/v1", keyEnv: "FEATHERLESS_API_KEY", tier: "free",
    tps: 45, ttft: 2200, models: ["meta-llama/Llama-3.3-70B-Instruct"], prefer: "llama-3.3|qwen" },
  // Keyless. Last among the free rows on purpose — an open endpoint is the one
  // thing that still answers when not a single API key is configured, which is
  // the difference between "degraded" and "dead" for a fresh deployment.
  { vendor: "pollinations", base: "https://gen.pollinations.ai/v1", keyEnv: null, tier: "free",
    tps: 35, ttft: 3000, priority: 19, models: ["openai-large"], prefer: "openai|llama|mistral|qwen" },

  // ── CREDIT: finite balances. Rank after every free tier, before paid. ─────
  { vendor: "deepinfra", base: "https://api.deepinfra.com/v1/openai", keyEnv: "DEEPINFRA_API_KEY", tier: "credit",
    tags: ["coder", "reasoning", "long"], tps: 90, ttft: 1200,
    models: ["openai/gpt-oss-120b", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3.1"], prefer: "gpt-oss|qwen3-coder|llama-3.3|deepseek" },
  { vendor: "fireworks", base: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", tier: "credit",
    tags: ["coder", "reasoning", "fast", "long"], tps: 120, ttft: 900,
    models: ["accounts/fireworks/models/gpt-oss-120b", "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct", "accounts/fireworks/models/llama-v3p3-70b-instruct"], prefer: "gpt-oss|qwen3-coder|llama" },
  { vendor: "together", base: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY", tier: "credit",
    tags: ["coder"], tps: 80, ttft: 1400,
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "Qwen/Qwen3-14B", "meta-llama/Llama-3.3-70B-Instruct"], prefer: "gpt-oss|qwen3|llama-3.3" },

  // ── PAID: metered. Only ever reached when nothing free is answering. ──────
  { vendor: "deepseek", base: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", tier: "paid",
    tags: ["coder", "reasoning"], tps: 60, models: ["deepseek-chat", "deepseek-reasoner"] },
  { vendor: "moonshot", base: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY", tier: "paid",
    tags: ["coder", "long"], tps: 60, models: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview"], prefer: "kimi" },
  { vendor: "xai", base: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", tier: "paid",
    tags: ["reasoning"], tps: 90, models: ["grok-4-fast-non-reasoning", "grok-4-fast-reasoning"], prefer: "grok.*fast" },
  { vendor: "openai", base: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", tier: "paid",
    tags: ["coder", "reasoning", "vision"], tps: 70, models: ["gpt-5-mini", "gpt-4.1-mini"], prefer: "gpt-5-mini|gpt-4.1-mini" },
  { vendor: "anthropic", base: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", tier: "paid",
    tags: ["coder", "reasoning", "vision"], tps: 60, models: ["claude-sonnet-4-5", "claude-haiku-4-5"], prefer: "haiku|sonnet" },
];

// ───────────────────────────────────────────────────────────────────────────
//  QUALITY PRIOR — editorial, per upstream model id, 0–100. Drives `auto`/
//  `best`/tag ordering. Dated 2026-09; override any row with
//  OMNI_QUALITY='{"regex":score,…}' without redeploying.
// ───────────────────────────────────────────────────────────────────────────
const QUALITY: [RegExp, number][] = [
  [/deepseek-v4-pro/i, 95], [/kimi-k3/i, 94], [/qwen3\.8-2\.4t/i, 93], [/glm-5\.3(?!-flash)/i, 92], [/nemotron-3-ultra/i, 90],
  [/deepseek-v4-flash/i, 88], [/minimax-m3/i, 86], [/qwen3-coder-next|qwen3-coder-plus/i, 86], [/qwen[-.]?3\.8-27b/i, 85],
  [/glm-5\.3-flash|glm-5-turbo/i, 84], [/nemotron-3-super/i, 84], [/deepseek-v3\.2|deepseek-v3\.1/i, 84], [/kimi-k2/i, 83], [/gpt-oss-120b/i, 82],
  [/claude-sonnet/i, 92], [/claude-haiku/i, 84], [/gpt-5-mini/i, 88], [/grok-4/i, 88], [/deepseek-chat|deepseek-reasoner/i, 90],
  [/gemini-2\.5-flash(?!-lite)/i, 80], [/gemma-4-31b/i, 80], [/qwen3\.6|qwen3\.7|qwen-plus/i, 78], [/nemotron-3\.5-lightning/i, 76],
  [/gemini-2\.5-flash-lite|gemini-2\.0-flash/i, 74], [/glm-4\.5-air|glm-4\.7/i, 72], [/mistral-small|devstral/i, 72], [/command-a/i, 72], [/qwen3-30b|qwen3-32b|qwen3-235b/i, 72],
  [/llama-3\.3-70b|llama-3_3-70b|llama-v3p3-70b/i, 70], [/gpt-oss-20b/i, 70], [/nemotron-70b|nemotron-51b/i, 68], [/qwen3-14b/i, 65], [/ministral-14b/i, 62],
  [/qwen3-8b|glm-4-9b/i, 55], [/ministral-8b|llama-3\.1-8b/i, 50], [/openai-large/i, 45],
];

let qualityOverride: [RegExp, number][] | null = null;
/** 0–100. Anything unrecognised scores 40: below every known model, above
 *  nothing, so an unknown id is tried but never preferred. */
export function quality(id: string): number {
  if (qualityOverride === null) {
    qualityOverride = [];
    try {
      for (const [k, v] of Object.entries(JSON.parse(env("OMNI_QUALITY") ?? "{}"))) {
        const n = Number(v);
        if (Number.isFinite(n)) qualityOverride.push([new RegExp(k, "i"), Math.max(0, Math.min(100, n))]);
      }
    } catch { /* a malformed override must not take the catalog down with it */ }
  }
  for (const [rx, q] of qualityOverride) if (rx.test(id)) return q;
  for (const [rx, q] of QUALITY) if (rx.test(id)) return q;
  return 40;
}

// ───────────────────────────────────────────────────────────────────────────
//  ENVIRONMENT OVERRIDES — the only runtime knobs, all documented in README.
// ───────────────────────────────────────────────────────────────────────────
/** The one env reader. `Deno.env.get` throws under a restricted permission set,
 *  and a catalog that cannot be read must still load — so every read is guarded
 *  here rather than at each of the thirty call sites that would otherwise each
 *  need its own try/catch. Exported because router.ts, router-api.ts and
 *  app-infer.ts all need the same guarded read, and three private copies of it is
 *  how one of them ends up unguarded. */
export const env = (k: string): string | undefined => {
  try { return (globalThis as any).Deno?.env?.get?.(k); } catch { return undefined; }
};
export const envStr = (k: string): string => env(k) ?? "";
export const envNum = (k: string, d: number): number => {
  const n = Number(envStr(k));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
};

/** OMNI_DISABLE="openrouter,groq" — skip vendors without editing the catalog. */
const disabled = (): Set<string> =>
  new Set((env("OMNI_DISABLE") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/** OMNI_PROVIDERS='[{"vendor":"acme","base":"https://…/v1","keyEnv":"ACME_KEY","models":["m1"]}]'
 *  Merged by `vendor`: an existing row is patched field-by-field (so you can
 *  override one vendor's `models` without restating its base URL), a new one is
 *  appended. This is how a provider gets added without a deploy. */
function applyOverrides(rows: Vendor[]): Vendor[] {
  const out = rows.map((r) => ({ ...r }));
  const raw = env("OMNI_PROVIDERS");
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) {
    console.error("[providers] OMNI_PROVIDERS is not valid JSON, ignoring:", String((e as Error)?.message ?? e).slice(0, 200));
    return out;
  }
  if (!Array.isArray(parsed)) { console.error("[providers] OMNI_PROVIDERS must be a JSON array, ignoring"); return out; }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<Vendor> & { vendor?: string };
    if (typeof row.vendor !== "string" || !row.vendor) continue;
    const i = out.findIndex((r) => r.vendor === row.vendor);
    if (i === -1) {
      // A brand-new vendor needs the three fields nothing can guess.
      if (typeof row.base !== "string" || !Array.isArray(row.models) || !row.models.length) {
        console.error(`[providers] OMNI_PROVIDERS: "${row.vendor}" is new and needs base + models[], ignoring`);
        continue;
      }
      out.push({ tier: "free", ...row } as Vendor);
    } else {
      out[i] = { ...out[i], ...row } as Vendor;
    }
  }
  return out;
}

/** `${CF_ACCOUNT_ID}` interpolation. A base whose env var is missing is a URL
 *  with a literal `${…}` in it, which throws at fetch time wearing a network
 *  error's clothes — so it is reported as a key issue instead, up front. */
function interpolate(base: string): { base: string; missing: string | null } {
  let missing: string | null = null;
  const out = base.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = env(name);
    if (!v) { missing = name; return ""; }
    return v;
  });
  return { base: out, missing };
}

// ───────────────────────────────────────────────────────────────────────────
//  INSTANCES
// ───────────────────────────────────────────────────────────────────────────
export type Instance = Vendor & {
  /** `vendor` for slot 0, `vendor#n` otherwise. The identity cooldowns,
   *  statistics and bindings are keyed by. */
  name: string;
  id: string; // = vendor; the `provider` table's natural key
  slot: number;
  key: string | null;
  keyEnvUsed: string | null;
  /** Non-null ⇒ the secret's VALUE is malformed. Such an instance is never
   *  called; it is reported, because a malformed key otherwise surfaces as an
   *  upstream 401 three layers away from its cause. */
  keyIssue: string | null;
  baseResolved: string;
  rank: number; // tier band + declaration order; the last tie-break
};

const KEY_SLOTS = 10;

/** Secret-value sanity. A GEMINI_API_KEY was once observed live with a literal
 *  `…3, }` suffix — a JSON fragment pasted into a secret field — and it sat
 *  there across several diagnostic pulls because nothing said "this cannot be a
 *  key" until an upstream 400 did, buried in a trail. Leading/trailing
 *  whitespace is the one defect safe to repair silently (no real key contains
 *  it); everything else is reported, never guessed at. */
export function keyIssue(raw: string): string | null {
  if (/^["'`]|["'`]$/.test(raw)) return "wrapped in quotes";
  if (/[{}\[\],]/.test(raw)) return "contains JSON punctuation ({ } [ ] ,)";
  if (/\s/.test(raw)) return "contains internal whitespace";
  if (/^bearer\s/i.test(raw)) return 'starts with "Bearer " — paste only the token';
  if (raw.length < 8) return `implausibly short (${raw.length} chars)`;
  return null;
}

/** One secret may hold several keys, comma-separated. It may also hold ONE key
 *  with a comma in the middle of a pasted JSON fragment — which is the exact
 *  defect keyIssue() exists to report.
 *
 *  Splitting unconditionally gets that wrong in the worst possible direction: the
 *  live case this was written for was a GEMINI_API_KEY holding `aiza…3, }`, and a
 *  blind split turns it into a plausible-looking 15-character truncated key plus a
 *  junk sibling instance. The router would then send the truncated key, get a 401
 *  from Google, and report "provider auth failure" — never once saying "this
 *  secret has a brace in it". So: split ONLY when every part is independently
 *  plausible. Otherwise hand the whole value to keyIssue() and let it say what is
 *  wrong with it. Failing toward a diagnosis beats failing toward a quiet 401. */
export function splitKeys(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (!trimmed.includes(",")) return [trimmed];
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((p) => keyIssue(p) === null) ? parts : [trimmed];
}

let roster: Instance[] | null = null;

/** Every usable instance: catalog rows × key slots, minus OMNI_DISABLE.
 *  Computed once per isolate — it is pure over a module constant and the
 *  environment, neither of which changes inside an isolate's life. */
export function instances(): Instance[] {
  if (roster) return roster;
  const off = disabled();
  const out: Instance[] = [];
  const rows = applyOverrides(VENDORS).filter((v) => !off.has(v.vendor.toLowerCase()));
  rows.forEach((v, i) => {
    const { base, missing } = interpolate(v.base);
    const tier = v.tier ?? "free";
    const rank = (v.priority ?? TIER_RANK[tier]) * 1000 + i;
    const push = (slot: number, keyEnvUsed: string | null, key: string | null) => {
      // BOTH defects are reported, and the base URL's is not conditional on the
      // key being absent: Cloudflare needs CLOUDFLARE_API_KEY *and* CF_ACCOUNT_ID,
      // and a key that is present used to hide the missing account id entirely —
      // which then surfaced as an "Invalid URL" at fetch time, three layers away
      // from its cause and wearing a network error's clothes.
      const secret = key ? keyIssue(key) : null;
      const issue = [secret, missing ? `missing env ${missing} (needed by base URL)` : null].filter(Boolean).join("; ") || null;
      out.push({
        ...v, tier, rank, baseResolved: base, slot, key, keyEnvUsed,
        keyIssue: issue, id: v.vendor, name: slot ? `${v.vendor}#${slot}` : v.vendor,
      });
    };
    if (!v.keyEnv) { push(0, null, null); return; }
    let slots = 0;
    for (let s = 0; s < KEY_SLOTS; s++) {
      // "k1,k2,k3" in one secret is as valid as three separate ones: people
      // paste a list far more often than they create KEY1/KEY2/KEY3.
      for (const key of splitKeys(env(v.keyEnv + (s ? String(s) : "")) ?? "")) {
        push(slots++, v.keyEnv + (s ? String(s) : ""), key);
      }
    }
  });
  roster = out.sort((a, b) => a.rank - b.rank || a.slot - b.slot);
  return roster;
}

/** Test seam: drop the memoised roster (and every cached env read) so a test or
 *  an admin reset sees the environment as it is NOW. */
export function resetRoster(): void { roster = null; }

export const vendorsOf = (list: Instance[] = instances()): string[] =>
  [...new Set(list.map((i) => i.vendor))];

/** All catalog rows for the status UI. No key material, ever. */
export function catalogStatus() {
  const live = instances();
  return applyOverrides(VENDORS).map((v, i) => {
    const tier = v.tier ?? "free";
    const slots = live.filter((x) => x.vendor === v.vendor);
    return {
      id: v.vendor, vendor: v.vendor, name: v.vendor, base: v.base, keyEnv: v.keyEnv, tier,
      tags: v.tags ?? [], models: v.models, defaultModel: v.models[0] ?? null,
      rank: (v.priority ?? TIER_RANK[tier]) * 1000 + i,
      disabled: disabled().has(v.vendor.toLowerCase()),
      hasKey: !v.keyEnv || slots.length > 0,
      keySlots: slots.length,
      keyIssues: slots.filter((s) => s.keyIssue).map((s) => ({ env: s.keyEnvUsed, issue: s.keyIssue })),
      fallbackModel: v.models[0] ?? null, // alias: the matrix UI reads this name
    };
  }).sort((a, b) => a.rank - b.rank);
}

// ───────────────────────────────────────────────────────────────────────────
//  PROMPT MATHS
// ───────────────────────────────────────────────────────────────────────────
/** ~4 chars/token. Deliberately crude: it only has to be good enough to decide
 *  "this prompt cannot fit that vendor" and "how much output room is left in
 *  this minute's token budget". Under-estimating by 10% costs one wasted
 *  attempt; a real tokenizer on the hot path costs every attempt. */
export function estimateTokens(messages: unknown[], tools?: unknown[]): number {
  let chars = 0;
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const c = (m as any)?.content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) for (const part of c) chars += typeof part?.text === "string" ? part.text.length : 64;
    else if (c != null) chars += JSON.stringify(c).length;
    const tc = (m as any)?.tool_calls;
    if (Array.isArray(tc) && tc.length) chars += JSON.stringify(tc).length;
    chars += 4; // role/name separators
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 4);
}

/** Can this instance take a prompt of this size? `learnedIn` is a ceiling the
 *  router measured from a real 413 (see router.ts), which beats the catalog's
 *  estimate the moment one exists. */
export function promptFits(p: Instance, promptTokens: number, learnedIn?: number): boolean {
  const limit = Math.min(p.maxIn ?? Infinity, learnedIn ?? Infinity);
  return Number.isFinite(limit) ? promptTokens <= limit : true;
}

/** What to actually send as `max_tokens`.
 *
 *  Three ceilings, smallest wins: the caller's request, the vendor's per-request
 *  output cap, and what is left of the vendor's per-minute token meter after the
 *  prompt is paid for. The third is the one that matters on free tiers — Groq
 *  meters prompt + max_tokens together at ~6k TPM, so a 4k prompt asking for
 *  16k output is rejected on arrival, and the rejection reads like a rate limit
 *  rather than like an oversized request.
 *
 *  Floored at 256: reasoning models (gpt-oss, qwen3.x) spend `max_tokens` on
 *  thinking FIRST, and a floor below ~256 yields finish_reason "length" with
 *  empty content — a reply that looks like a provider failure and is arithmetic. */
export function clampMaxTokens(p: Instance, promptTokens: number, requested: number | undefined): number {
  const ask = requested && requested > 0 ? requested : 4096;
  const room = p.tpm ? Math.max(0, p.tpm - promptTokens) : Infinity;
  const n = Math.min(ask, p.maxOut ?? Infinity, room);
  return Number.isFinite(n) ? Math.max(256, Math.floor(n)) : Math.max(256, Math.floor(ask));
}

/** Expected ms to a COMPLETE reply of `expectTokens`. Used by `fast` ordering
 *  and by the deadline check that decides whether a slow vendor is even worth
 *  starting. `tpsMeasured` (a learned EMA) beats the catalog estimate. */
export function etaMs(p: Instance, expectTokens: number, tpsMeasured?: number): number {
  const tps = Math.max(1, tpsMeasured ?? p.tps ?? 60);
  return (p.ttft ?? 1500) + Math.round((Math.max(64, expectTokens) / tps) * 1000);
}

// ───────────────────────────────────────────────────────────────────────────
//  TARGET RESOLUTION — what `model` means
//
//  The contract is: a value the caller can explain gets honoured exactly, and a
//  value nobody can explain is a 404. Never a silent reroute — an answer from a
//  different model than the one asked for is worse than no answer, because it is
//  indistinguishable from the model you asked for misbehaving.
// ───────────────────────────────────────────────────────────────────────────
export type Mode = "quality" | "latency";
export type Match = "all" | "tag" | "vendor" | "instance" | "model" | "none";

export type TargetSet = {
  /** Instances eligible for this request, in CATALOG order. Ranking against the
   *  live health state happens in router.ts, which is the only place that knows
   *  what is cooling down. */
  candidates: Instance[];
  /** Upstream model id the caller pinned, or null for "the vendor's own choice". */
  forcedModel: string | null;
  mode: Mode;
  tag: Tag | null;
  match: Match;
};

export const META_MODELS = new Set(["auto", "best", "fast", ""]);
export const TAGS: Tag[] = ["coder", "reasoning", "long", "vision"];

export function resolveTargets(requested: string | undefined | null, live: Instance[] = instances()): TargetSet {
  const all = { candidates: live, forcedModel: null, mode: "quality" as Mode, tag: null, match: "all" as Match };
  const raw = (requested ?? "").trim();
  if (META_MODELS.has(raw.toLowerCase())) {
    return { ...all, mode: raw.toLowerCase() === "fast" ? "latency" : "quality" };
  }
  const lower = raw.toLowerCase();
  if ((TAGS as string[]).includes(lower)) {
    const tag = lower as Tag;
    const tagged = live.filter((p) => p.tags?.includes(tag));
    // Tagged first, but the untagged rest stay in the list: a meta-model must
    // still degrade to *something* rather than 404 when no coder-tagged vendor
    // has a key.
    return { candidates: [...tagged, ...live.filter((p) => !tagged.includes(p))], forcedModel: null, mode: "quality", tag, match: "tag" };
  }

  // "groq#2" — one specific key slot.
  const slotMatch = raw.match(/^([a-z0-9_]+)#(\d+)$/i);
  if (slotMatch) {
    const hit = live.filter((p) => p.name.toLowerCase() === raw.toLowerCase());
    if (hit.length) return { candidates: hit, forcedModel: null, mode: "quality", tag: null, match: "instance" };
  }
  // A bare vendor name.
  const byVendor = live.filter((p) => p.vendor.toLowerCase() === lower);
  if (byVendor.length) return { candidates: byVendor, forcedModel: null, mode: "quality", tag: null, match: "vendor" };

  const sep = raw.search(/[:/]/);
  const head = sep === -1 ? raw : raw.slice(0, sep);
  const tail = sep === -1 ? "" : raw.slice(sep + 1);
  const headIsVendor = live.some((p) => p.vendor.toLowerCase() === head.toLowerCase());
  const serving = (id: string) => live.filter((p) => p.models.some((m) => m.toLowerCase() === id.toLowerCase()));

  // 1. "vendor:model" where that vendor really lists that model.
  if (headIsVendor && tail) {
    const hit = live.filter((p) => p.vendor.toLowerCase() === head.toLowerCase() && p.models.some((m) => m.toLowerCase() === tail.toLowerCase()));
    if (hit.length) return { candidates: hit, forcedModel: tail, mode: "quality", tag: null, match: "model" };
  }
  // 2. The whole string is an upstream id some vendor serves. This is what makes
  //    the endpoint a drop-in for an OpenAI SDK pointed at it: `gpt-oss-120b`,
  //    `openai/gpt-oss-120b` and `nvidia/nemotron-3-super-120b-a12b:free` all
  //    land on the vendors that actually serve them. Checked BEFORE the generic
  //    vendor-prefix split, or `openai/gpt-oss-120b` would read as a pin to
  //    OpenAI — which has never served it.
  const serves = serving(raw);
  if (serves.length) return { candidates: serves, forcedModel: raw, mode: "quality", tag: null, match: "model" };
  // 3. "vendor:something-we-don't-list". Still honoured: the catalog goes stale,
  //    and the named vendor is a better guess than any other. Upstream answers
  //    404 and the caller sees exactly what was asked for.
  if (headIsVendor && tail) return { candidates: byVendorHead(head, live), forcedModel: tail, mode: "quality", tag: null, match: "vendor" };
  return { candidates: [], forcedModel: null, mode: "quality", tag: null, match: "none" };
}

const byVendorHead = (head: string, live: Instance[]) =>
  live.filter((p) => p.vendor.toLowerCase() === head.toLowerCase());

/** Human-readable list of every accepted `model` value, for the 404 body and
 *  /health. A 404 that says what WOULD have worked turns a support question
 *  into a self-service answer. */
export function knownModelValues(live: Instance[] = instances()): string[] {
  const vendors = vendorsOf(live);
  return [
    ...["auto", "best", "fast"], ...TAGS, ...vendors,
    ...live.filter((p) => p.slot > 0).map((p) => p.name),
    ...[...new Set(live.flatMap((p) => p.models))],
  ];
}
