import type { ProviderInstance } from "./inference-provider.ts";
import { isDead } from "./router-state.ts";

export function headersFor(p: ProviderInstance): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "HTTP-Referer": "https://val.town", "X-Title": "omni", ...p.headers };
  if (p.key) h.Authorization = `Bearer ${p.key}`;
  return h;
}


/** Live /models lookup → first id matching the vendor's `prefer` regex that isn't dead. */
export async function discover(p: ProviderInstance): Promise<string | null> {
  if (!p.prefer) return null;
  try {
    const res = await fetch(`${p.base}/models`, { headers: headersFor(p) });
    if (!res.ok) return null;
    const data = await res.json();
    const ids: string[] = (data.data ?? data).map((m: any) => (typeof m === "string" ? m : m.id)).filter(Boolean);
    const rx = new RegExp(p.prefer, "i");
    // never "discover" non-chat endpoints: guard/moderation, ASR, TTS, embeddings, rerankers
    const JUNK = /guard|safeguard|moderat|whisper|tts|speech|embed|rerank|playai|vision-only|ocr|\bstt\b/i;
    return ids.find((id) => rx.test(id) && !JUNK.test(id) && !isDead(p.vendor, id)) ?? null;
  } catch { return null; }
}

