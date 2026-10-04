// Drop-in client for any val/project that talks to the router.
//   import { omni } from "https://esm.town/v/ziggyware/free-ai/omni-client.ts";
//   const r = await omni.chat([{ role: "user", content: "hi" }], { model: "coder" });
//   r.text, r.message, r.meta.provider.vendor
//
// The router is a module of the free-ai app, not a separate deployment, so the
// default endpoint is that app's own /v1/chat/completions. Set OMNI_URL to point
// this client at a different deployment of it.
//
// Env (optional): OMNI_URL (default https://free-ai.val.run), OMNI_CLIENT_KEY
// (an entry from the server's OMNI_CLIENT_KEYS, if that gate is configured).
//
// Retries the whole route once on 502/503/504/network: the router already fails
// over across every provider internally, so a retry here covers a cold isolate or
// a transport blip, not a provider outage. A 413 is deliberately NOT retried —
// it means every candidate vendor was too small for the prompt, and resending the
// identical prompt is guaranteed to fail identically. Shrink the messages instead.

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; [k: string]: unknown };
export type ChatOpts = {
  model?: string; tools?: unknown[]; tool_choice?: unknown; temperature?: number; max_tokens?: number;
  reasoning_effort?: string; top_p?: number; stop?: string[] | string; seed?: number;
  response_format?: unknown; signal?: AbortSignal; retries?: number; url?: string; key?: string;
  /** Routing controls the router understands. All optional; all were previously
   *  unreachable from this client, which is why the settings panel's vendor order
   *  and key rotation fields had no effect on anything a caller did. */
  deadlineMs?: number;
  /** Absolute instant (Date.now() + N). Preferred over deadlineMs across a hop:
   *  a duration is re-based when it lands, so it silently grows by the flight time. */
  deadlineAt?: number;
  vendorOrder?: string[] | string;
  exclude?: string[] | string;
  keyPolicy?: "breadth" | "depth" | "rr";
  expectTokens?: number;
};
export type ChatResult = {
  message: { role: string; content: string | null; tool_calls?: unknown[]; reasoning?: string };
  text: string; finish_reason: string; model: string;
  meta: {
    provider: { name: string; vendor: string; tier?: string };
    instance?: string; latency_ms?: number; max_tokens_sent?: number;
    plan?: string[];
    attempts?: { provider: string; vendor: string; model: string; pass: number; ok: boolean; skipped?: boolean; latencyMs?: number; dropped?: string[]; error?: string }[];
    /** Candidates the router refused to call at all, and why. */
    skipped?: { name: string; vendor: string; why: string }[];
  };
  raw: any;
};

const envOf = (k: string): string | undefined => { try { return Deno.env.get(k); } catch { return undefined; } };
const base = (o: ChatOpts) => (o.url ?? envOf("OMNI_URL") ?? "https://free-ai.val.run").replace(/\/+$/, "");
const headers = (o: ChatOpts) => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = o.key ?? envOf("OMNI_CLIENT_KEY") ?? envOf("OMNI_CLIENT_KEYS");
  if (k) h.Authorization = `Bearer ${k.split(",")[0].trim()}`;
  return h;
};
/** Everything a caller may set, including the router's own `omni_*` extensions.
 *  Undefined values are dropped rather than sent: a JSON `null` for `tools` is
 *  not the same as an absent `tools` to every upstream vendor. */
const body = (messages: Msg[], o: ChatOpts, stream: boolean) => {
  const payload: Record<string, unknown> = {
    messages, stream,
    model: o.model, tools: o.tools, tool_choice: o.tool_choice, temperature: o.temperature,
    max_tokens: o.max_tokens, response_format: o.response_format, reasoning_effort: o.reasoning_effort,
    top_p: o.top_p, stop: o.stop, seed: o.seed,
    omni_deadline_ms: o.deadlineMs, omni_deadline_at: o.deadlineAt,
    omni_vendor_order: o.vendorOrder, omni_exclude: o.exclude,
    omni_key_policy: o.keyPolicy, omni_expect_tokens: o.expectTokens,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return JSON.stringify(payload);
};
/** Retryable at the transport level. 413 and 404 are answers, not blips. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function chat(messages: Msg[], o: ChatOpts = {}): Promise<ChatResult> {
  const tries = 1 + (o.retries ?? 1);
  let last: Error = new Error("unreachable");
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base(o)}/v1/chat/completions`, { method: "POST", headers: headers(o), body: body(messages, o, false), signal: o.signal });
      const j = await res.json().catch(() => null);
      // A 200 carrying an error body is a failure: some upstreams and some edge
      // layers do this, and treating it as success is how an empty reply reaches
      // the caller wearing a provider's name.
      if (!res.ok || j?.error) {
        const err = j?.error;
        const detail = typeof err === "string" ? err : err?.message ?? `HTTP ${res.status}`;
        const e = Object.assign(new Error(detail), {
          status: res.status, code: err?.code ?? null, details: err?.details ?? null,
          // Carried up so a caller can tell the user which vendors were never
          // even asked, instead of guessing from a status code.
          skipped: err?.skipped ?? null, plan: err?.plan ?? null, attempts: err?.attempts ?? null,
        });
        if (RETRYABLE.has(res.status) && i + 1 < tries) { last = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); continue; }
        throw e;
      }
      if (!j?.choices?.[0]) throw Object.assign(new Error(`router returned no choices (HTTP ${res.status})`), { status: 502 });
      const c = j.choices[0];
      return { message: c.message, text: c.message?.content ?? "", finish_reason: c.finish_reason ?? "stop", model: j.model, meta: j._omni_meta, raw: j };
    } catch (e: any) {
      last = e;
      // A network failure has no status and is worth one retry; anything the
      // server answered with is final unless it is in RETRYABLE.
      if (e.status && !RETRYABLE.has(e.status)) throw e;
    }
  }
  throw last;
}

/** Async iterator of content deltas. `for await (const tok of omni.stream(msgs)) …` */
async function* stream(messages: Msg[], o: ChatOpts = {}): AsyncGenerator<string, void, void> {
  const res = await fetch(`${base(o)}/v1/chat/completions`, { method: "POST", headers: headers(o), body: body(messages, o, true), signal: o.signal });
  if (!res.ok || !res.body) {
    // The error body may be JSON or may be an edge's HTML page; read it as text
    // first so a non-JSON body cannot mask the real status.
    const text = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { if (text) msg = text.slice(0, 200); }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  const rd = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await rd.read();
    if (done) return;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) yield d; } catch { /* keepalive / partial */ }
    }
  }
}

const models = async (o: ChatOpts = {}) => (await (await fetch(`${base(o)}/v1/models`, { headers: headers(o) })).json()).data as { id: string }[];
const health = async (o: ChatOpts = {}) => await (await fetch(`${base(o)}/health`)).json();

export const omni = { chat, stream, models, health };
