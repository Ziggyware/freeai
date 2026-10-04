// Drop-in client for any val/project that talks to the router.
//   import { omni } from "https://esm.town/v/ziggyware/free-ai/omni-client.ts";
//   const r = await omni.chat([{ role: "user", content: "hi" }], { model: "coder" });
//   r.text, r.message, r.meta.provider.name
// Env (optional): OMNI_URL (default https://router.val.run), OMNI_CLIENT_KEY.
// Retries the whole route once on 503/network (the router already fails over
// across every provider internally; this covers a cold isolate or a blip).

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; [k: string]: unknown };
export type ChatOpts = {
  model?: string; tools?: unknown[]; tool_choice?: unknown; temperature?: number; max_tokens?: number;
  response_format?: unknown; signal?: AbortSignal; retries?: number; url?: string; key?: string;
};
export type ChatResult = {
  message: { role: string; content: string | null; tool_calls?: unknown[] };
  text: string; finish_reason: string; model: string;
  meta: { provider: { name: string; vendor: string }; latency_ms: number; attempts: number };
  raw: any;
};

const base = (o: ChatOpts) => (o.url ?? Deno.env.get("OMNI_URL") ?? "https://router.val.run").replace(/\/$/, "");
const headers = (o: ChatOpts) => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = o.key ?? Deno.env.get("OMNI_CLIENT_KEY");
  if (k) h.Authorization = `Bearer ${k}`;
  return h;
};
const body = (messages: Msg[], o: ChatOpts, stream: boolean) =>
  JSON.stringify({ messages, model: o.model, tools: o.tools, tool_choice: o.tool_choice, temperature: o.temperature, max_tokens: o.max_tokens, response_format: o.response_format, stream });

async function chat(messages: Msg[], o: ChatOpts = {}): Promise<ChatResult> {
  const tries = 1 + (o.retries ?? 1);
  let last: Error = new Error("unreachable");
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base(o)}/v1/chat/completions`, { method: "POST", headers: headers(o), body: body(messages, o, false), signal: o.signal });
      const j = await res.json();
      if (!res.ok || j.error) {
        const e = Object.assign(new Error(j?.error?.message ?? `HTTP ${res.status}`), { status: res.status, details: j?.error?.details });
        if (res.status === 503 && i + 1 < tries) { last = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); continue; }
        throw e;
      }
      const c = j.choices[0];
      return { message: c.message, text: c.message?.content ?? "", finish_reason: c.finish_reason ?? "stop", model: j.model, meta: j._omni_meta, raw: j };
    } catch (e: any) {
      last = e;
      if (e.status && e.status !== 503) throw e;
    }
  }
  throw last;
}

/** Async iterator of content deltas. `for await (const tok of omni.stream(msgs)) …` */
async function* stream(messages: Msg[], o: ChatOpts = {}): AsyncGenerator<string, void, void> {
  const res = await fetch(`${base(o)}/v1/chat/completions`, { method: "POST", headers: headers(o), body: body(messages, o, true), signal: o.signal });
  if (!res.ok || !res.body) throw Object.assign(new Error((await res.json().catch(() => ({})))?.error?.message ?? `HTTP ${res.status}`), { status: res.status });
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
