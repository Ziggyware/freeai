// ═══════════════════════════════════════════════════════════════════════════
//  ROUTER API — the two protocols on top of the routing engine.
//
//  router.ts decides which provider answers next. This file is how that decision
//  is asked for and how the answer is handed back:
//
//   · the OpenAI chat.completions contract, both as a plain function the app
//     calls in process (`chatCompletions`) and as an HTTP Response for external
//     clients (`chatCompletionsResponse`), streaming and not;
//   · the HTTP routes app.tsx mounts (`routerRoutes`): /health, /v1/models,
//     /api/providers, /api/models, /api/update, /api/reset, /api/reset-stats and
//     the matrix UI at /router.
//
//  It is a separate file for one mundane reason and one good one. Mundane: Val
//  Town rejects a file over 80,000 characters, and the engine plus both protocols
//  is 81k. Good: "what a provider said" and "what a caller asked" are different
//  kinds of knowledge, and the seam between them is exactly where the last
//  routing bug lived — `reasoning_effort` was accepted by the HTTP route,
//  forwarded by the client, and dropped on the floor by the engine, because the
//  parameter list existed twice and only one of them had it. `optsFromBody` below
//  is now the only place a request body is read, and FORWARD_PARAMS in router.ts
//  the only place a parameter list is written.
// ═══════════════════════════════════════════════════════════════════════════
import { catalogStatus, envStr, instances, resetRoster, type Instance } from "./providers.ts";
import { ROUTER_MATRIX_HTML } from "./ui-router.ts";
import {
  bindModel,
  coolingUntil,
  cooldownInfo,
  FORWARD_PARAMS,
  getInstanceRoster,
  getSavedModels,
  inflight,
  invalidateState,
  isCooling,
  listUpstreamModels,
  MAX_CONCURRENCY,
  resetCooldowns,
  resetProviderStats,
  routeChat,
  type RouteHit,
  type RouteOpts,
  stateView,
  TRAIL_CAP,
  unbindModel,
} from "./router.ts";

// ───────────────────────────────────────────────────────────────────────────
//  REQUEST SHAPING — the only place a caller's body is read
// ───────────────────────────────────────────────────────────────────────────
/** Split a raw OpenAI-shaped body into (messages, opts). ONE place knows the
 *  parameter names, so the HTTP surface and the in-process surface cannot drift
 *  apart — which is exactly how `reasoning_effort` came to be accepted by the
 *  HTTP route, forwarded by the client, and dropped on the floor by the router. */
export function optsFromBody(body: any): { messages: unknown[]; opts: RouteOpts } {
  const messages = Array.isArray(body?.messages) && body.messages.length
    ? body.messages
    : body?.prompt ? [{ role: "user", content: String(body.prompt) }] : [];
  const extra: Record<string, unknown> = {};
  for (const k of FORWARD_PARAMS) if (body?.[k] !== undefined) extra[k] = body[k];
  const strList = (v: unknown): string[] => Array.isArray(v)
    ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    : typeof v === "string" ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  const hasMax = typeof body?.max_tokens === "number";
  const hasMaxC = typeof body?.max_completion_tokens === "number";
  return {
    messages,
    opts: {
      model: typeof body?.model === "string" ? body.model : null,
      tools: Array.isArray(body?.tools) ? body.tools : undefined,
      tool_choice: body?.tool_choice,
      response_format: body?.response_format,
      temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
      max_tokens: hasMax ? body.max_tokens : hasMaxC ? body.max_completion_tokens : undefined,
      maxTokensField: !hasMax && hasMaxC ? "max_completion_tokens" : "max_tokens",
      stream: !!body?.stream,
      extra,
      deadlineMs: typeof body?.omni_deadline_ms === "number" && body.omni_deadline_ms > 0 ? body.omni_deadline_ms : undefined,
      deadlineAt: typeof body?.omni_deadline_at === "number" && Number.isFinite(body.omni_deadline_at) ? body.omni_deadline_at : undefined,
      expectTokens: typeof body?.omni_expect_tokens === "number" && body.omni_expect_tokens > 0 ? body.omni_expect_tokens : undefined,
      keyPolicy: ["depth", "rr", "breadth"].includes(body?.omni_key_policy) ? body.omni_key_policy : null,
      vendorOrder: strList(body?.omni_vendor_order).slice(0, 12),
      exclude: strList(body?.omni_exclude).slice(0, 24),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
//  THE OPENAI SURFACE
// ───────────────────────────────────────────────────────────────────────────
const CORS = { "Access-Control-Allow-Origin": "*" };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

/** Provenance, with no key material in it — this object goes back to callers. */
const sanitize = (p: Instance) => ({
  id: p.id, name: p.name, vendor: p.vendor, tier: p.tier, base: p.baseResolved,
  keyEnv: p.keyEnv, slot: p.slot, rank: p.rank, fallbackModel: p.models[0] ?? null,
});

export const routeMeta = (hit: RouteHit) => ({
  provider: sanitize(hit.provider),
  model: hit.model,
  instance: hit.provider.name,
  latency_ms: hit.latencyMs,
  max_tokens_sent: hit.maxTokensSent,
  inflight_requests: inflight,
  plan: hit.plan ?? null,
  skipped: hit.skipped?.length ? hit.skipped : null,
  attempts: hit.trail ? hit.trail.slice(-TRAIL_CAP) : null,
});

const errorBody = (e: any) => ({
  error: {
    message: String(e?.message ?? e),
    type: "routing_error",
    code: e?.code ?? null,
    details: e?.errors?.length ? e.errors : null,
    plan: e?.plan ?? null,
    skipped: e?.skipped?.length ? e.skipped : null,
    attempts: e?.trail ? e.trail.slice(-TRAIL_CAP) : null,
    known_models: e?.code === "UNKNOWN_MODEL" ? (e.plan ?? []) : undefined,
  },
});

/** In-process, non-streaming: the shape the app's own inference client wants.
 *  No Request, no Response, and no second JSON parse of a body this module just
 *  serialised — which is what routing the app's own calls through a loopback
 *  HTTP hop cost on every single model call it made. */
export async function chatCompletions(body: any): Promise<{ status: number; json: any }> {
  const { messages, opts } = optsFromBody(body);
  if (!messages.length) {
    return { status: 400, json: { error: { message: "Empty message payload: `messages` must be a non-empty array (or send `prompt`)." } } };
  }
  let hit: RouteHit;
  try {
    hit = await routeChat(messages, { ...opts, stream: false });
  } catch (e: any) {
    return { status: e?.status ?? 503, json: errorBody(e) };
  }
  const up = JSON.parse(hit.text ?? "{}");
  return { status: 200, json: { ...up, model: up.model ?? hit.model, _omni_meta: routeMeta(hit) } };
}

/** The HTTP surface, streaming and non-streaming, for external OpenAI clients. */
export async function chatCompletionsResponse(body: any): Promise<Response> {
  const { messages, opts } = optsFromBody(body);
  if (!messages.length) return json({ error: { message: "Empty message payload: `messages` must be a non-empty array (or send `prompt`)." } }, 400);
  let hit: RouteHit;
  try {
    hit = await routeChat(messages, opts);
  } catch (e: any) {
    return json(errorBody(e), e?.status ?? 503);
  }
  const m = routeMeta(hit);

  if (!opts.stream || !hit.res) {
    const up = JSON.parse(hit.text ?? "{}");
    return json({ ...up, model: up.model ?? hit.model, _omni_meta: m });
  }

  // SSE passthrough, byte for byte. One comment line carries the provenance so a
  // client can read it without parsing chunks; OpenAI SDKs ignore ":"-prefixed
  // lines per the SSE spec.
  const enc = new TextEncoder();
  const head = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(`: omni ${JSON.stringify(m)}\n\n`)); c.close(); } });
  const upstream = hit.res.body ?? new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const out = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        for (const s of [head, upstream]) {
          const r = s.getReader();
          for (;;) { const { done, value } = await r.read(); if (done) break; c.enqueue(value); }
        }
      } catch { /* an idle-aborted stream ends here; the client sees the connection close */ }
      finally { try { c.close(); } catch { /* already closed */ } }
    },
    cancel() { hit.res?.body?.cancel().catch(() => {}); },
  });
  return new Response(out, {
    headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "X-Omni-Provider": hit.provider.name, "X-Omni-Model": hit.model, ...CORS,
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
//  HTTP ROUTES — mounted by app.tsx. Returns null for anything that is not a
//  router route, so the app's own handler keeps going.
// ───────────────────────────────────────────────────────────────────────────
const CHAT_PATHS = new Set(["/chat/completions", "/v1/chat/completions"]);
const ROUTER_PATHS = new Set([
  "/health", "/v1/models", "/models", "/api/providers", "/api/models",
  "/api/update", "/api/reset", "/api/reset-stats", "/api/router", "/router",
]);

/** OMNI_CLIENT_KEYS gates the inference surface. It has been documented in the
 *  README since the router was written and was never once implemented, which
 *  meant a public URL spending its owner's API keys for anyone who found it.
 *  Unset = open, exactly as before; set = callers must present one of the keys.
 *  `/`, `/health` and `/router` stay open so a browser can still diagnose a gate
 *  that was misconfigured. */
const clientKeys = (): string[] => envStr("OMNI_CLIENT_KEYS").split(",").map((s) => s.trim()).filter(Boolean);
const adminKey = (): string => envStr("OMNI_ADMIN_KEY");

function suppliedKey(req: Request, url: URL): string {
  // ui-settings.ts already has a "router key" field it sends as
  // `Authorization: Bearer <key>`, and the matrix UI sends `X-Admin-Key`. Both
  // are recognised so neither needs changing, and ?key= covers the plain-fetch
  // console snippets that cannot set a header.
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    || (req.headers.get("x-admin-key") || "").trim()
    || (url.searchParams.get("key") || "").trim()
    || (url.searchParams.get("admin_key") || "").trim();
}
const clientAllowed = (req: Request, url: URL): boolean => {
  const keys = clientKeys();
  return keys.length === 0 || keys.includes(suppliedKey(req, url));
};
const adminAllowed = (req: Request, url: URL): boolean => {
  const key = adminKey();
  return !key || suppliedKey(req, url) === key;
};
const unauthorized = (what: string) => json({ error: `unauthorized — ${what} is set; send it back as Authorization: Bearer <key>, X-Admin-Key, or ?key=` }, 401);

/** Aggregate model list, cached. This used to fan out to every provider's
 *  `/models` on every call with NO timeout at all, so one hung vendor could
 *  stall the endpoint for as long as the platform allowed. */
let modelsCache: { at: number; value: any } | null = null;
/** Drop the aggregated /v1/models response. Called by /api/reset, and exported so
 *  a caller that changed the roster underneath this module (resetRoster, a new
 *  OMNI_PROVIDERS value, a test) is not served a model list describing vendors
 *  that are no longer there. A 5-minute TTL is right for a client polling for
 *  models; it is wrong for a list built from a roster that just changed. */
export function clearModelsCache(): void { modelsCache = null; }
const MODELS_TTL_MS = 300_000;

async function aggregateModels(force = false) {
  if (!force && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value;
  const live = instances();
  const saved = await getSavedModels();
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  // One row per routable vendor, with the model currently bound to it.
  for (const p of live) {
    if (seen.has(p.vendor)) continue;
    seen.add(p.vendor);
    rows.push({ id: p.vendor, object: "model", owned_by: p.vendor, tier: p.tier, bound: saved[p.vendor] ?? p.models[0] ?? null, candidates: p.models });
  }
  // Every catalog model id, unnamespaced: what an OpenAI SDK is most likely to
  // ask for by name.
  for (const p of live) {
    for (const id of p.models) {
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, object: "model", owned_by: p.vendor });
    }
  }
  // Plus every live upstream id namespaced "<vendor>:<id>", so a client can pin
  // vendor+model. Slot 0 only, and each lookup individually bounded: a vendor
  // that hangs costs its own timeout, not the endpoint.
  const results = await Promise.all(live.filter((p) => p.slot === 0).map(async (p) => {
    try {
      const ids = await listUpstreamModels(p, 5_000, force);
      return ids.map((id) => ({ id: `${p.vendor}:${id}`, object: "model", owned_by: p.vendor }));
    } catch { return []; }
  }));
  for (const row of results.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const value = { object: "list", data: rows };
  modelsCache = { at: Date.now(), value };
  return value;
}

export async function routerRoutes(req: Request, url: URL = new URL(req.url)): Promise<Response | null> {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  // POST / belongs to the app unless it carries nothing the app recognises: every
  // app route on "/" is query-parameter driven (?q, ?plan, ?build_file, …), so a
  // bare POST / with a JSON body is an OpenAI client. Without this guard the
  // router would swallow the chat endpoint.
  const APP_ROOT_PARAMS = ["q", "plan", "build_file", "build_start", "build_cancel", "report_errors", "drain", "compact", "rename", "clear", "artifact_save", "artifact_save_many", "artifact_delete_file", "issue"];
  const isChatPath = CHAT_PATHS.has(path) ||
    (path === "/" && !APP_ROOT_PARAMS.some((k) => url.searchParams.has(k)) && !url.searchParams.toString());
  const isChat = req.method === "POST" && isChatPath;
  // A CORS preflight is an OPTIONS, not a POST: without this a browser-based
  // OpenAI client's preflight to /v1/chat/completions fell through to the app's
  // own handler and 404'd, which reads as "the endpoint does not exist" rather
  // than "the endpoint needs CORS headers".
  const isPreflight = req.method === "OPTIONS" && (isChatPath || ROUTER_PATHS.has(path));
  if (!isChat && !isPreflight && !ROUTER_PATHS.has(path)) return null;

  if (req.method === "OPTIONS") {
    if (!isPreflight) return null;
    return new Response(null, {
      status: 204,
      headers: { ...CORS, "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Max-Age": "86400" },
    });
  }

  if (req.method === "GET") {
    if (path === "/health") {
      const live = instances();
      const keyIssues = live.filter((p) => p.keyIssue).map((p) => ({ instance: p.name, env: p.keyEnvUsed, issue: p.keyIssue }));
      const byTier = live.reduce<Record<string, number>>((a, p) => { const k = p.tier ?? "free"; a[k] = (a[k] ?? 0) + 1; return a; }, {});
      return json({
        status: live.length ? (keyIssues.length ? "ok-with-key-issues" : "ok") : "degraded",
        providers_configured: live.length,
        vendors: [...new Set(live.map((p) => p.vendor))].length,
        by_tier: byTier,
        inflight_requests: inflight,
        max_concurrency: MAX_CONCURRENCY,
        // A malformed secret is the most common answer to "why does X never
        // work", so it is top-level rather than buried per instance.
        key_issues: keyIssues,
        key_policy: "ready-before-cooling · free→credit→paid · tag · quality|eta · measured health · vendor round-robin",
        auth: { client_keys: clientKeys().length > 0, admin_key: !!adminKey() },
        instances: await getInstanceRoster(),
        state: stateView(),
      });
    }

    if (path === "/api/providers" || path === "/api/router") {
      const saved = await getSavedModels();
      return json(catalogStatus().map((p) => ({
        ...p,
        currentModel: saved[p.vendor] || p.defaultModel,
        cooling: isCooling(p.vendor) ? { ms_left: coolingUntil(p.vendor) - Date.now(), reason: cooldownInfo(p.vendor)?.reason ?? "" } : null,
      })));
    }

    if (path === "/api/models") {
      const name = url.searchParams.get("provider") ?? "";
      const p = instances().find((x) => x.name === name || x.vendor === name);
      // Every error branch carries `fallback`, including this one. A vendor with no
      // key is absent from instances() — it cannot be called — but the catalog
      // still knows its default model, and the matrix UI renders `fallback` as a
      // row when the live list is unavailable. Omitting it here meant the one case
      // an operator is most likely to hit first (no key yet) was the only case that
      // answered with nothing to show.
      const catalogRow = catalogStatus().find((c) => c.vendor === name || c.name === name);
      if (!p) {
        return json(
          catalogRow
            ? { error: `Provider "${name}" is in the catalog but has no usable key${catalogRow.keyEnv ? ` — set ${catalogRow.keyEnv}` : ""}`, fallback: catalogRow.fallbackModel }
            : { error: "Provider not found" },
          404,
        );
      }
      if (p.keyIssue) return json({ error: `Key for ${p.keyEnvUsed} is unusable: ${p.keyIssue}`, fallback: p.models[0] ?? null }, 502);
      try {
        const ids = await listUpstreamModels(p, 8_000);
        return json(ids.map((id) => ({ id, object: "model", owned_by: p.vendor })));
      } catch (e: any) {
        return json({ error: String(e?.message ?? e), fallback: p.models[0] ?? null }, 502);
      }
    }

    if (path === "/v1/models" || path === "/models") {
      if (!clientAllowed(req, url)) return unauthorized("OMNI_CLIENT_KEYS");
      try { return json(await aggregateModels(url.searchParams.get("refresh") === "1")); } catch (e: any) {
        return json({ error: { message: String(e?.message ?? e) } }, 502);
      }
    }

    if (path === "/router") return new Response(ROUTER_MATRIX_HTML, { headers: { "Content-Type": "text/html", ...CORS } });
    return null;
  }

  if (req.method === "POST") {
    if (path === "/api/update") {
      if (!adminAllowed(req, url)) return unauthorized("OMNI_ADMIN_KEY");
      const body = await req.json().catch(() => ({}));
      const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
      if (!provider) return json({ error: "provider required — a vendor id from GET /api/providers" }, 400);
      const vendor = provider.split("#")[0];
      if (!instances().some((p) => p.vendor === vendor)) {
        return json({ error: `unknown provider "${provider}"`, known: [...new Set(instances().map((p) => p.vendor))] }, 404);
      }
      // model:null (or "") clears the override so the vendor falls back to its
      // catalog default. Without an unbind, a dead override outlives the catalog
      // fix underneath it.
      if (body?.model == null || body.model === "") {
        const d = await unbindModel(vendor);
        modelsCache = null;
        return d.ok === false ? json({ error: (d as any).error }, 500) : json({ success: true, cleared: vendor });
      }
      const model = String(body.model);
      const r = await bindModel(vendor, model);
      modelsCache = null;
      if (r.ok === false) return json({ error: (r as any).error }, 500);
      return json({ success: true, provider: vendor, model });
    }

    // Cooldowns, dead model ids and learned ceilings: the LIVE routing decision.
    if (path === "/api/reset") {
      if (!adminAllowed(req, url)) return unauthorized("OMNI_ADMIN_KEY");
      const body = await req.json().catch(() => ({}));
      const name = typeof body?.provider === "string" ? body.provider.trim() : "";
      const cleared = await resetCooldowns(name);
      resetRoster();
      invalidateState();
      modelsCache = null;
      return json({ success: true, scope: name || "all", ...cleared });
    }

    // Durable request/ok/failed counters: the diagnostic HISTORY. Kept separate
    // from /api/reset so clearing a stuck cooldown does not also erase the
    // evidence that it was stuck. (These two routes had collapsed into the same
    // single DELETE, which made one of them a lie.)
    if (path === "/api/reset-stats") {
      if (!adminAllowed(req, url)) return unauthorized("OMNI_ADMIN_KEY");
      await resetProviderStats();
      return json({ success: true, cleared: "provider_stats" });
    }

    if (isChat) {
      if (!clientAllowed(req, url)) return unauthorized("OMNI_CLIENT_KEYS");
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: { message: "Invalid JSON body" } }, 400); }
      return await chatCompletionsResponse(body);
    }
    return null;
  }

  return null;
}

