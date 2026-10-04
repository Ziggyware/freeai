// OpenAI chat.completions surface over routeInference. Streams are piped
// byte-for-byte from upstream (real token streaming); failover happens only
// before the first upstream byte, which is the only point it can happen.
import { inflight, type RouteHit, routeInference, type RouteOpts } from "./router-core.ts";

const CORS = { "Access-Control-Allow-Origin": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const sanitize = (p: RouteHit["provider"]) => ({
  id: p.id, name: p.name, vendor: p.vendor, base: p.base, keyEnv: p.keyEnv, slot: p.slot, priority: p.priority, fallbackModel: p.fallbackModel,
});

// Trail/plan are capped here (not just at storage time — see app.tsx's slimEvents cap) so a pathological
// worst case (10 full passes × ~20 providers) can't blow up the response payload itself; the last N entries
// are what matters for a flowchart anyway — earlier passes of the same provider list are redundant detail.
const TRAIL_CAP = 60;
const meta = (hit: RouteHit) => ({
  provider: sanitize(hit.provider),
  model: hit.model,
  latency_ms: hit.latencyMs,
  inflight_requests: inflight,
  plan: hit.plan ?? null,
  attempts: hit.trail ? hit.trail.slice(-TRAIL_CAP) : null,
});

export async function handleChatCompletions(body: any): Promise<Response> {
  const messages = body?.messages ?? (body?.prompt ? [{ role: "user", content: body.prompt }] : []);
  if (!Array.isArray(messages) || !messages.length) return json({ error: { message: "Empty message payload" } }, 400);
  const opts: RouteOpts = {
    model: body.model, tools: body.tools, tool_choice: body.tool_choice,
    temperature: body.temperature, max_tokens: body.max_tokens, stream: !!body.stream,
    response_format: body.response_format,
    // The client sends both an absolute deadline and a remaining duration. routeInference slices this
    // caller-owned budget across provider candidates instead of giving the first candidate the full cap.
    deadlineMs: typeof body.omni_deadline_ms === "number" && body.omni_deadline_ms > 0 ? body.omni_deadline_ms : undefined,
    // Preferred over the duration: an instant cannot be re-based by transport time (see app-infer.ts).
    deadlineAt: typeof body.omni_deadline_at === "number" && Number.isFinite(body.omni_deadline_at) ? body.omni_deadline_at : undefined,
  };
  let hit: RouteHit;
  try {
    hit = await routeInference(messages, opts);
  } catch (e: any) {
    // Exhaustion still carries a full trail — a flowchart that shows "everything tried, then a 503" is
    // strictly more useful than one that goes dark the moment there's no winner to hang it off of.
    return json({ error: { message: e.message, details: e.errors ?? null, plan: e.plan ?? null, attempts: e.trail ? e.trail.slice(-TRAIL_CAP) : null } }, e.status ?? 503);
  }
  const m = meta(hit);

  if (!opts.stream) {
    const up = await hit.res.json();
    return json({ ...up, model: up.model ?? hit.model, _omni_meta: m });
  }

  // SSE passthrough. Prepend one comment line carrying _omni_meta so clients
  // that want provenance can read it without parsing chunks; OpenAI SDKs
  // ignore ":"-prefixed lines per the SSE spec.
  const enc = new TextEncoder();
  const head = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(`: omni ${JSON.stringify(m)}\n\n`)); c.close(); },
  });
  const upstream = hit.res.body ?? new ReadableStream({ start(c) { c.close(); } });
  const out = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const s of [head, upstream]) {
        const r = s.getReader();
        for (;;) { const { done, value } = await r.read(); if (done) break; c.enqueue(value); }
      }
      c.close();
    },
    cancel() { hit.res.body?.cancel().catch(() => {}); },
  });
  return new Response(out, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Omni-Provider": hit.provider.name, "X-Omni-Model": hit.model, ...CORS },
  });
}
