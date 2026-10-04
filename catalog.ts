// Vendor catalog. One row per OpenAI-compatible endpoint. `models` is the
// ordered fallback list; `prefer` picks a replacement from the vendor's live
// /models when every listed id 404s. `${ENV}` in `base` is interpolated.
// Override/extend at runtime with OMNI_PROVIDERS (JSON array, merged by vendor)
// and OMNI_DISABLE (comma list of vendors). Priority: lower = tried first;
// 0–19 free & fast, 20–39 free & slow/quota'd, 40+ paid last resort.
export type Vendor = {
  vendor: string;
  base: string;
  keyEnv: string | null;
  models: string[];
  prefer?: string; // regex source, case-insensitive
  priority: number;
  tags?: string[]; // coder | reasoning | fast | long | vision
  headers?: Record<string, string>;
  paid?: boolean; // paid vendors rank after every free one in `auto`, whatever their quality
  tps?: number; // measured/estimated output tokens per second (default 60)
  ttft?: number; // typical ms to first token (default 1500)
  maxOut?: number; // clamp for max_tokens: free tiers meter prompt+max_tokens per minute (Groq TPM 8000)
  maxIn?: number; // largest prompt (tokens) the free tier accepts per request; prompts above it skip the vendor without a wasted call
};

import { FREE } from "./catalog-free.ts";
import { PAID } from "./catalog-paid.ts";
export const CATALOG: Vendor[] = [...FREE, ...PAID];

// Quality prior per upstream model id (0–100). Drives `auto`/`best` ordering:
// higher first across vendors, then vendor priority as tie-break. Editorial,
// dated 2026-09; override any row via OMNI_QUALITY='{"regex":score,…}'.
const QUALITY: [RegExp, number][] = [
  [/deepseek-v4-pro/i, 95], [/kimi-k3/i, 94], [/qwen3\.8-2\.4t/i, 93], [/glm-5\.3(?!-flash)/i, 92], [/nemotron-3-ultra/i, 90],
  [/deepseek-v4-flash/i, 88], [/minimax-m3/i, 86], [/qwen3-coder-next|qwen3-coder-plus/i, 86], [/qwen[-.]?3\.8-27b/i, 85],
  [/glm-5\.3-flash|glm-5-turbo/i, 84], [/nemotron-3-super/i, 84], [/deepseek-v3\.2/i, 84], [/kimi-k2/i, 83], [/gpt-oss-120b/i, 82],
  [/gemini-2\.5-flash(?!-lite)/i, 80], [/gemma-4-31b/i, 80], [/qwen3\.6|qwen3\.7/i, 78], [/nemotron-3\.5-lightning/i, 76],
  [/gemini-2\.5-flash-lite/i, 74], [/glm-4\.5-air|glm-4\.7/i, 72], [/mistral-small/i, 72], [/command-a/i, 72], [/qwen3-30b|qwen3-32b/i, 72],
  [/llama-3\.3-70b|llama-3_3-70b/i, 70], [/gpt-oss-20b/i, 70], [/nemotron-70b|nemotron-51b/i, 68], [/qwen3-14b/i, 65], [/ministral-14b/i, 62],
  [/qwen3-8b/i, 55], [/ministral-8b|llama-3\.1-8b/i, 50], [/gpt-5-mini/i, 88], [/claude-sonnet/i, 92], [/claude-haiku/i, 84], [/deepseek-chat|deepseek-reasoner/i, 90], [/grok-4/i, 88],
];
let override: [RegExp, number][] | null = null;
export function quality(id: string): number {
  if (override === null) {
    override = [];
    try { for (const [k, v] of Object.entries(JSON.parse(Deno.env.get("OMNI_QUALITY") ?? "{}"))) override.push([new RegExp(k, "i"), Number(v)]); } catch { /* ignore */ }
  }
  for (const [rx, q] of override) if (rx.test(id)) return q;
  for (const [rx, q] of QUALITY) if (rx.test(id)) return q;
  return 40;
}
