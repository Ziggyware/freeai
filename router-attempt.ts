import type { ProviderInstance } from "./inference-provider.ts";
import { headersFor } from "./router-discover.ts";

export type RouteOpts = { model?: string; stream?: boolean; extra?: Record<string, unknown>; deadlineMs?: number; expectTokens?: number; keyPolicy?: "depth" | "breadth" | "rr"; vendorOrder?: string[]; exclude?: string[] };
export type Fail = Error & { kind: "model" | "rate" | "auth" | "quota" | "size" | "transient"; retryAfterMs?: number; sentMax?: number; resetAt?: number };
const QUOTA = /balance|recharge|insufficient|余额|credits?|quota|billing|payment|per[ _-]day|daily|monthly|exceeded your|free.?tier|limit reached for the day|\b[rt]pd\b/i;
/** When a quota-class failure heals: header epoch, "daily" → next UTC midnight, else re-probe in 6 h (funds/credits can be added any time). */
export function quotaResetAt(res: Response | null, body: string): number {
  const now = Date.now();
  const h = res?.headers.get("x-ratelimit-reset") ?? res?.headers.get("x-ratelimit-reset-requests") ?? "";
  const n = Number(h);
  if (n > 0) { const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000; if (ms > now && ms < now + 36 * 3_600_000) return ms; }
  if (/per day|daily|for the day|today/i.test(body)) { const d = new Date(now); d.setUTCHours(24, 0, 0, 0); return d.getTime() + 60_000; }
  return now + 6 * 3_600_000;
}
// "Limit 6000, Requested 9000" (Groq TPM) or "maximum context length is 8192 tokens ... requested 9000": shrink to fit.
export function shrinkMaxTokens(o: RouteOpts, body: string, sent?: number): boolean {
  const cur = sent || Number(o.extra?.max_tokens);
  if (!cur || cur <= 512) return false;
  const lim = body.match(/limit[^\d]{0,12}(\d+)/i), req = body.match(/request(?:ed)?[^\d]{0,12}(\d+)/i);
  const next = lim && req ? Math.min(cur - (Number(req[1]) - Number(lim[1])) - 64, Number(lim[1]) - 64) : Math.floor(cur / 2);
  o.extra = { ...o.extra, max_tokens: Math.max(512, Math.min(next, cur - 256)) };
  return true;
}
/** A size error the PROMPT alone caused: shrinking max_tokens cannot fix it. Groq ITPM, context-length overflows. Returns the input limit when stated. */
export function inputBound(body: string): number | null {
  if (!/input tokens|ITPM|prompt tokens|context length|maximum context|too many tokens in (the )?prompt/i.test(body)) return null;
  const m = body.match(/limit[^\d]{0,12}(\d+)/i) ?? body.match(/context length (?:of|is) (\d+)/i);
  return m ? Number(m[1]) : 0;
}
/** Rough prompt size in tokens: chars/3.6 over messages + tool schemas (vendors tokenize JSON worse than prose). */
export const estimateInputTokens = (messages: unknown[], extra?: Record<string, unknown>) => Math.ceil((JSON.stringify(messages).length + (extra?.tools ? JSON.stringify(extra.tools).length : 0)) / 3.6);
/** "Limit N" from a size error when it is an output ceiling (OTPM / max_tokens), else null */
export function outputLimit(body: string): number | null {
  if (!/output|max_tokens|completion/i.test(body)) return null;
  const m = body.match(/limit[^\d]{0,12}(\d+)/i) ?? body.match(/(?:less than or equal to|maximum value[^\d]{0,30}is|at most)[^\d]{0,6}(\d+)/i);
  return m ? Number(m[1]) : null;
}

export function classify(status: number, body: string): Fail["kind"] {
  if ((status === 429 || status === 413 || status === 400) && /too large|too long|context length|maximum context|exceeds.*tokens|reduce.*(length|tokens)/i.test(body)) return "size";
  if (status === 429 && QUOTA.test(body)) return "quota";
  if ((status === 429 || status === 400) && /max_tokens.{0,40}(less than or equal|maximum value|must be at most)|maximum value for .max_tokens/i.test(body)) return "size";
  if (status === 429) return "rate";
  if (status === 404 || /model_not_found|invalid.model|tier_not_allowed|does not (exist|support)|not (found|exist|supported|available)|unsupported|decommissioned|deprecated|no access|unable to access/i.test(body)) return "model";
  // A 400 is a request/output defect, never billing: the body often quotes the model's own generation (tool_use_failed
  // carries failed_generation), and any "credits"/"balance" word in that text would otherwise cool the key for hours.
  if (status === 400) return "transient";
  if (status === 402 || (status === 403 && QUOTA.test(body))) return "quota";
  if (status === 401 || status === 403 || /api.?key|unauthorized|invalid.?token/i.test(body)) return "auth";
  return "transient";
}

// timeoutMs covers headers AND (non-stream) body: a slow vendor streaming a long
// completion past the deadline is the failure mode that killed 60 s turns.
// capMax: the largest completion this vendor can stream before the deadline; a
// truncated answer (finish_reason "length") beats a timeout — the caller continues it.
export async function attempt(p: ProviderInstance, model: string, messages: unknown[], o: RouteOpts, timeoutMs: number, capMax = Infinity): Promise<Response> {
  const payload: Record<string, unknown> = { ...o.extra, model, messages, stream: !!o.stream };
  const cap = Math.min(p.maxOut ?? Infinity, capMax);
  if (Number(payload.max_tokens) > cap) payload.max_tokens = cap;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const abortP = new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(Object.assign(new Error("TIMEOUT"), { kind: "transient" }))));
  try {
    const res = await Promise.race([fetch(`${p.base}/chat/completions`, { method: "POST", headers: headersFor(p), body: JSON.stringify(payload), signal: ctl.signal }), abortP]);
    if (res.ok) {
      if (o.stream) return res;
      const text = await Promise.race([res.text(), abortP]).catch((e) => { res.body?.cancel().catch(() => {}); throw e; });
      return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "x-omni-sent-max": String(payload.max_tokens ?? "") } });
    }
    const body = await res.text().catch(() => "");
    const e = new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`) as Fail;
    e.kind = classify(res.status, body);
    // 429 with "remaining: 0" and a reset far away is a quota even when the body says nothing useful (OpenRouter free-models-per-day)
    if (e.kind === "rate" && res.headers.get("x-ratelimit-remaining") === "0") { const at = quotaResetAt(res, body); if (at - Date.now() > 5 * 60_000) e.kind = "quota"; }
    e.sentMax = Number(payload.max_tokens) || undefined;
    const ra = Number(res.headers.get("retry-after")) || Number((body.match(/try again in\s*([\d.]+)\s*s/i) ?? [])[1]) || 0;
    if (e.kind === "rate" && ra > 0) e.retryAfterMs = Math.min(Math.ceil(ra * 1000) + 500, 15 * 60_000);
    if (e.kind === "quota") e.resetAt = quotaResetAt(res, body);
    throw e;
  } catch (e: any) {
    if (!e.kind) { e.kind = "transient"; e.message = e.name === "AbortError" ? "TIMEOUT" : `NETWORK: ${e.message}`; }
    ctl.abort();
    throw e;
  } finally { clearTimeout(timer); }
}

