// Instance = catalog row × key slot (KEY, KEY1…KEY9 → name#n). keyEnv null ⇒ keyless.
import type { Row } from "./db.ts";

// Same shape as the `provider` table row, with `model` required: every catalog
// entry must name a default upstream id — name is "<vendor>/<label>".
export type ProviderSpec = Omit<Row<"provider">, "model"> & { model: string; tags?: string[]; paid?: boolean };

export type ProviderInstance = ProviderSpec & {
  vendor: string;
  slot: number;
  key: string | null;
  keyIssue: string | null; // non-null ⇒ the secret's VALUE is malformed (see keyIssue()); surfaced on /health and in the catalog
  fallbackModel: string;
};

const KEY_SLOTS = 10;

// Secret-value sanity. GEMINI_API_KEY was observed live this session with a literal `…3, }` suffix —
// a JSON fragment pasted into the secret field — and it sat there across multiple diagnostics pulls
// because nothing anywhere said "this key cannot be right" until an upstream 400 did, buried in a trail.
// Leading/trailing whitespace is the one defect that is safe to repair silently (no real key contains
// it); everything else is reported, never guessed at. Returns the reason, or null for a plausible key.
export function keyIssue(raw: string): string | null {
  if (/^["'`]|["'`]$/.test(raw)) return "wrapped in quotes";
  if (/[{}\[\],]/.test(raw)) return "contains JSON punctuation ({ } [ ] ,)";
  if (/\s/.test(raw)) return "contains internal whitespace";
  if (/^bearer\s/i.test(raw)) return 'starts with "Bearer " — paste only the token';
  if (raw.length < 8) return `implausibly short (${raw.length} chars)`;
  return null;
}

// ids verified 2026-09-08. Dropped: github_models (410, retiring), deepinfra (paid).
// tags mirror v2/catalog-free.ts's vendor-level assignments (openrouter, huggingface, mistral, zai
// are its "coder"-tagged vendors); ported here because app.tsx sends model:"coder" as a routing tag
// for app-scale builds (see app.tsx ~line 1288), which this catalog previously had no way to honor.
export const CATALOG: ProviderSpec[] = [
  /* THREE VENDORS, CHOSEN ON THEIR MEASURED RECORD. Every row here earned its place in provider_stats;
     nothing is listed because it is free or because it was listed before.

       fireworks/gpt-oss-120b     8 ok /  10   80%   paid, and the only row that behaves like infrastructure
       together/gpt-oss-120b      4 ok /  18   22%
       groq/gpt-oss-120b (x5)    42 ok / 281   15%   five key slots; daily TPD cap is the ceiling

     Removed, with their measured records: openrouter across fifteen instances (~25 ok / ~1,500 requests,
     0.8-2.7%, and the sole reason for the credit-cooldown machinery), cerebras, sambanova, huggingface,
     mistral, anthropic, openai, deepinfra (all 402/403 payment-required), nvidia_nim (410, model retired),
     gemini (key malformed — re-add it once GEMINI_API_KEY is a bare key, it has a real free tier), zai,
     siliconflow and ovh (no keys). Re-adding one is a line here; nothing else in the system needs to know.

     They all serve the same model deliberately. A fallback chain whose members disagree about what they
     are produces answers that vary by which provider happened to be up, which is its own bug. */
  { id: "1", name: "fireworks/gpt-oss-120b", base: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/gpt-oss-120b", keyEnv: "FIREWORKS_API_KEY", priority: 0, tags: ["coder", "reasoning", "fast", "long"] },
  { id: "2", name: "together/gpt-oss-120b", base: "https://api.together.xyz/v1", model: "openai/gpt-oss-120b", keyEnv: "TOGETHER_API_KEY", priority: 1, tags: ["coder", "reasoning", "long"] },
  { id: "3", name: "groq/gpt-oss-120b", base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", keyEnv: "GROQ_API_KEY", priority: 2, tags: ["coder", "reasoning", "fast"] },
];


const vendorOf = (name: string) => name.split("/")[0];

const instance = (p: ProviderSpec, slot: number, keyEnv: string | null, key: string | null): ProviderInstance =>
  ({ ...p, keyEnv, key, keyIssue: key ? keyIssue(key) : null, slot, vendor: vendorOf(p.name), name: slot ? `${p.name}#${slot}` : p.name, fallbackModel: p.model });

export function getProviderArray(): ProviderInstance[] {
  const out: ProviderInstance[] = [];
  for (const p of CATALOG) {
    if (!p.keyEnv) { out.push(instance(p, 0, null, null)); continue; }
    for (let i = 0; i < KEY_SLOTS; i++) {
      const env = p.keyEnv + (i ? String(i) : "");
      const key = Deno.env.get(env)?.trim(); // surrounding whitespace is the one defect repaired silently — see keyIssue()
      if (key) out.push(instance(p, i, env, key));
    }
  }
  return out.sort((a, b) => a.priority - b.priority || a.slot - b.slot);
}

/** All catalog rows for status/UI; no key material. */
export function getCatalogStatus() {
  const live = getProviderArray();
  return CATALOG.map((p) => {
    const slots = live.filter((i) => i.id === p.id);
    return {
      ...p,
      vendor: vendorOf(p.name),
      fallbackModel: p.model,
      hasKey: !p.keyEnv || slots.length > 0,
      keySlots: slots.length,
      keyIssues: slots.filter((i) => i.keyIssue).map((i) => ({ env: i.keyEnv, issue: i.keyIssue })),
    };
  }).sort((a, b) => a.priority - b.priority);
}

/** request `model`: ""|"auto"|"fast" → chain (this router has no quality-vs-priority reordering, so
 *  "fast" — the UI's other bare meta-model, alongside "coder"/"reasoning" — is not distinct from "auto"
 *  here; both just mean "every configured provider, in existing priority order"); "coder"|"reasoning"|
 *  "long" → tagged instances first, then the rest (never a hard subset — a meta-model must still degrade
 *  to *something*); "<vendor>" | "<name>" → subset; "<vendor>:<upstream id>" → subset + forced id;
 *  unknown → [] (caller 404s). */
export function resolveTargets(requested: string | undefined, live: ProviderInstance[]) {
  if (!requested || requested === "auto" || requested === "fast") return { targets: live, forcedModel: null };
  if (/^(coder|reasoning|long|vision)$/.test(requested)) {
    const tagged = live.filter((p) => p.tags?.includes(requested));
    return { targets: [...tagged, ...live.filter((p) => !tagged.includes(p))], forcedModel: null };
  }
  const exact = live.filter((p) => p.name === requested || p.name.split("#")[0] === requested);
  if (exact.length) return { targets: exact, forcedModel: null };
  const colon = requested.indexOf(":");
  const vendor = colon === -1 ? requested : requested.slice(0, colon);
  const forced = colon === -1 ? null : requested.slice(colon + 1) || null; // "" (trailing colon) must fall through, not ship as model
  const byVendor = live.filter((p) => p.vendor === vendor);
  return { targets: byVendor, forcedModel: byVendor.length ? forced : null };
}
