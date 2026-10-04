import { T, routerAttemptTimeoutMs } from "./timing.ts";
import { getProviderArray, type ProviderInstance, resolveTargets } from "./inference-provider.ts";
import { all, bumpProviderStats, providerStatsAll, run, sql } from "./db.ts";

/* THE ROUTER, AFTER THE MEASUREMENT THAT SETTLED IT.
 *
 *   7,201 requests. 91 successes. 1.3%.
 *
 *  This file used to be 893 lines. Almost all of them existed to shuffle a 38-instance roster elegantly:
 *  a circuit-breaker state machine with OPEN/HALF_OPEN/CLOSED, cooldown windows parsed out of provider
 *  error bodies, config-dead demotion with cost-weighted strikes, cross-isolate breaker persistence and
 *  hydration, per-attempt cap arithmetic guaranteeing K attempts, ten-pass sweeps with fail-open
 *  restoration, vendor-breadth-first ordering with key-slot tiering, and a retry that re-read
 *  OpenRouter's "you can only afford N tokens" and asked again for N.
 *
 *  Every one of those was a correct fix for a real observed failure. Together they were a compensation
 *  mechanism for providers that did not work, and each layer was somewhere for a bug to hide — the last
 *  one being a deadline measured from a clock that started after three unbounded awaits, which let a
 *  8,964ms grant run for 20,051ms while every cap inside it was obeyed.
 *
 *  The roster is now three vendors, chosen on their measured record rather than on being free:
 *
 *      fireworks/gpt-oss-120b     8 ok /  10   80%
 *      together/gpt-oss-120b      4 ok /  18   22%
 *      groq/gpt-oss-120b (x5)    42 ok / 281   15%
 *
 *  against openrouter's ~25 ok / ~1,500 across fifteen instances. With a roster that answers, there is
 *  nothing left for the machinery to manage, so it is deleted rather than disabled. What remains is:
 *  try each instance in order, one attempt each, bounded by an absolute deadline that cannot drift.
 *
 *  What is deliberately kept, because each one was paid for in production:
 *   · the absolute deadline + one call-wide AbortController (budgets cannot be extended by sub-budgets)
 *   · per-candidate time slices that cover the full non-streaming response, preserving fallback time
 *   · cancellable FIFO admission, so queueing consumes the same deadline as inference
 *   · malformed-secret and empty/dots-only response checks
 *   · durable provider_stats, which is the only reason the paragraph above could be written
 */

export const MAX_CONCURRENCY = 3;

/** getProviderArray() is pure over a module constant and the environment, so it is computed once per
 *  isolate rather than on every route, every health check and every roster render. */
let rosterCache: ProviderInstance[] | null = null;
const rosterOnce = (): ProviderInstance[] => (rosterCache ??= getProviderArray());
export const HARD_TIMEOUT_MS = T.routerHardTimeout;
export const ROUTER_MIN_ATTEMPT_MS = T.routerMinAttempt;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export let inflight = 0;
// FIFO admission rather than a polling spin. A waiter is cancelled with the call-wide signal: queueing
// consumes the same deadline as provider work, and a request must not wait forever for a routing slot.
type RouteWaiter = { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal; onAbort: () => void; active: boolean };
const waiters: RouteWaiter[] = [];
async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw Object.assign(new Error("ROUTER_QUEUE_TIMEOUT: call deadline expired while waiting for a routing slot"), { status: 503, retryable: true });
  if (inflight < MAX_CONCURRENCY && waiters.length === 0) { inflight++; return; }
  await new Promise<void>((resolve, reject) => {
    const waiter: RouteWaiter = {
      resolve, reject, signal, active: true,
      onAbort: () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(Object.assign(new Error("ROUTER_QUEUE_TIMEOUT: call deadline expired while waiting for a routing slot"), { status: 503, retryable: true }));
      },
    };
    waiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
  });
}
function release(): void {
  inflight = Math.max(0, inflight - 1);
  while (waiters.length) {
    const next = waiters.shift()!;
    if (!next.active) continue;
    next.active = false;
    next.signal.removeEventListener("abort", next.onAbort);
    // Reserve the slot before waking the waiter so a newly arriving request cannot jump the FIFO queue.
    inflight++;
    next.resolve();
    return;
  }
}

export type RouteOpts = {
  model?: string; tools?: unknown[]; tool_choice?: unknown;
  temperature?: number; max_tokens?: number; stream?: boolean; response_format?: unknown;
  /** Caller's remaining wall-clock budget for the WHOLE call. Converted to an instant on entry. */
  deadlineMs?: number;
  /** An ABSOLUTE instant (epoch ms) this call must finish by. Preferred: an instant has no origin to
   *  displace, which is the entire class of bug that produced "8964ms granted, 20051ms spent". */
  deadlineAt?: number;
  /** Aborted when the caller gives up; cancels admission waits, fetches, and response-body reads. */
  signal?: AbortSignal;
};
export type RouteHit = { provider: ProviderInstance; model: string; latencyMs: number; res: Response; plan?: string[]; trail?: RouteAttempt[] };
export type RouteAttempt = {
  provider: string; vendor: string; model: string; pass: number; timeoutMs: number;
  ok: boolean; skipped?: boolean; latencyMs?: number; error?: string; ts: number;
};

function isEmptyOrDotContent(msg: any): boolean {
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) return false;
  if (typeof msg?.content !== "string") return false;
  const stripped = msg.content.replace(/\s+/g, "");
  return stripped.length === 0 || /^\.+$/.test(stripped);
}

async function attempt(p: ProviderInstance, model: string, messages: unknown[], o: RouteOpts, timeoutMs: number, callSignal?: AbortSignal): Promise<RouteHit> {
  if (p.keyIssue) throw Object.assign(new Error(`KEY_MALFORMED (${p.keyEnv}): ${p.keyIssue}`), { retryable: false, status: 0 });
  const payload: Record<string, unknown> = { model, messages, stream: !!o.stream };
  if (o.max_tokens && o.max_tokens > 0) payload.max_tokens = o.max_tokens;
  if (typeof o.temperature === "number") payload.temperature = o.temperature;
  // tool_choice:"none" with a tools array is equivalent to sending no tools; Groq rejects the combination.
  if (o.tools?.length && o.tool_choice !== "none") { payload.tools = o.tools; if (o.tool_choice) payload.tool_choice = o.tool_choice; }
  if (o.response_format) payload.response_format = o.response_format;

  const ctl = new AbortController();
  const t0 = performance.now();
  let rejectAttemptTimeout!: (reason: unknown) => void;
  const attemptTimedOut = new Promise<never>((_, reject) => { rejectAttemptTimeout = reject; });
  const timer = setTimeout(() => {
    ctl.abort();
    rejectAttemptTimeout(Object.assign(new Error("API_STALLED_TIMEOUT"), { retryable: true, name: "AbortError" }));
  }, timeoutMs);
  let rejectCallDeadline!: (reason: unknown) => void;
  const callDeadline = new Promise<never>((_, reject) => { rejectCallDeadline = reject; });
  const onCallAbort = () => {
    ctl.abort();
    rejectCallDeadline(Object.assign(new Error("CALL_DEADLINE_REACHED"), { retryable: true, name: "AbortError" }));
  };
  const unlink = () => callSignal?.removeEventListener("abort", onCallAbort);
  if (callSignal) {
    if (callSignal.aborted) onCallAbort();
    else callSignal.addEventListener("abort", onCallAbort, { once: true });
  }
  const withinAttempt = <T>(work: Promise<T>): Promise<T> => Promise.race([work, attemptTimedOut, callDeadline]);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "HTTP-Referer": "https://val.town", "X-Title": "Ziggyware-OmniRouter" };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    const res = await withinAttempt(fetch(`${p.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal: ctl.signal }));
    if (!res.ok) {
      const body = await withinAttempt(res.text());
      const e: any = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      e.retryable = RETRYABLE.has(res.status);
      e.status = res.status;
      throw e;
    }
    if (!o.stream) {
      // The same per-provider slice bounds headers AND the full body. Otherwise one fast header followed
      // by a stalled body can consume the entire shared deadline and starve every fallback provider.
      const text = await withinAttempt(res.text());
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* let router-openai.ts surface a malformed upstream reply */ }
      const msg = json?.choices?.[0]?.message;
      if (json && isEmptyOrDotContent(msg)) {
        throw Object.assign(new Error(`EMPTY_OR_DOT_RESPONSE: ${JSON.stringify(String(msg?.content ?? "")).slice(0, 60)}`), { retryable: true });
      }
      return { provider: p, model, latencyMs: Math.round(performance.now() - t0), res: new Response(text, { status: res.status, headers: res.headers }) };
    }
    // Streaming responses can only fail over before headers are returned; after this point the client owns the stream.
    return { provider: p, model, latencyMs: Math.round(performance.now() - t0), res };
  } catch (e: any) {
    if (callSignal?.aborted || e?.message === "CALL_DEADLINE_REACHED") {
      throw Object.assign(new Error("CALL_DEADLINE_REACHED"), { retryable: true, name: "AbortError" });
    }
    if (e?.name === "AbortError" || e?.message === "API_STALLED_TIMEOUT") {
      throw Object.assign(new Error("API_STALLED_TIMEOUT"), { retryable: true, configClass: true });
    }
    // Invalid request/URL construction is local configuration, not a transient upstream outage.
    if (e instanceof TypeError && /construct|Invalid URL|ByteString/i.test(String(e.message))) { e.retryable = false; e.configClass = true; }
    if (e.retryable === undefined) e.retryable = true;
    throw e;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/* A NETWORK READ ON EVERY INFERENCE, FOR A TABLE A HUMAN EDITS.
 *
 *  omni_router_config holds per-vendor model overrides — written when someone picks a model in the
 *  settings panel, read on the critical path of every routed call. That is one guaranteed round trip
 *  before the first provider is contacted, on a table whose contents change maybe twice a day.
 *
 *  Cached for SAVED_TTL_MS per isolate. The staleness window is bounded by the TTL, isolates are
 *  short-lived anyway, and the failure mode of a stale read is "one call used the previous model
 *  choice" — against a guaranteed round trip on every call, forever. A failed read is NOT cached, so a
 *  transient DB error cannot pin an empty override map for the isolate's lifetime. */
const SAVED_TTL_MS = 10_000;
let savedCache: { at: number; value: Record<string, string> } | null = null;
export async function getSavedModels(): Promise<Record<string, string>> {
  const now = Date.now();
  if (savedCache && now - savedCache.at < SAVED_TTL_MS) return savedCache.value;
  const r = await all("omni_router_config", sql`SELECT * FROM omni_router_config`);
  if (!r.ok) return savedCache?.value ?? {};
  const value = Object.fromEntries((r.value as any[]).map((row) => [row.provider, row.selected_model]));
  savedCache = { at: now, value };
  return value;
}
/** The settings panel writes this table; without an explicit drop, a model change would not take effect
 *  for up to SAVED_TTL_MS on the isolate that made it. */
export function invalidateSavedModels(): void { savedCache = null; }

export async function resetProviderStats(): Promise<void> {
  await run(sql`DELETE FROM provider_stats`).catch(() => {});
}

/** Per-instance roster for /health. Purely durable counters now — there is no breaker state to report,
 *  because there is no breaker. */
export async function getInstanceRoster() {
  const statsRow = await providerStatsAll();
  const stats = new Map((statsRow.ok ? statsRow.value : []).map((r: any) => [r.name, r]));
  return rosterOnce().map((p) => {
    const s = stats.get(p.name);
    return {
      name: p.name, key: p.key ? `${p.keyEnv}…${p.key.slice(-4)}` : null, key_issue: p.keyIssue,
      requests: s?.requests ?? 0, ok: s?.ok ?? 0, failed: s?.failed ?? 0,
      last_error: s?.last_error ?? null,
    };
  });
}

export async function routeInference(messages: unknown[], o: RouteOpts = {}): Promise<RouteHit> {
  // The clock starts on the FIRST line and is an INSTANT. A duration has to be measured from somewhere,
  // and "somewhere" used to be after acquire() + two DB round trips — so the router honoured its
  // deadline perfectly against an origin seconds later than the caller's.
  const enteredAt = Date.now();
  const hardCeiling = enteredAt + T.routerCeiling;
  const deadlineAt = Math.min(
    hardCeiling,
    typeof o.deadlineAt === "number" && Number.isFinite(o.deadlineAt)
      ? o.deadlineAt
      : o.deadlineMs && o.deadlineMs > 0
      ? enteredAt + o.deadlineMs
      : hardCeiling,
  );
  // One abort for the entire route, including admission-queue wait, provider headers and response body.
  const callCtl = new AbortController();
  const callTimer = setTimeout(() => callCtl.abort(), Math.max(0, deadlineAt - Date.now()));
  const onCallerAbort = () => callCtl.abort();
  if (o.signal?.aborted) callCtl.abort();
  else o.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let admitted = false;
  try {
    await acquire(callCtl.signal);
    admitted = true;
    const queuedMs = Date.now() - enteredAt;
    // Pure over the catalog constant and the env, neither of which changes within an isolate — but it
    // rebuilds the whole roster (catalog rows x 10 key slots, with a keyIssue regex pass over every
    // secret found) on each call. Built once here and reused by the roster below.
    const live = rosterOnce();
    if (!live.length) throw Object.assign(new Error("NO_PROVIDERS_CONFIGURED"), { status: 503 });
    const { targets, forcedModel } = resolveTargets(o.model, live);
    if (!targets.length) throw Object.assign(new Error(`UNKNOWN_MODEL: ${o.model}`), { status: 404 });
    const saved = await getSavedModels();
    const modelFor = (p: ProviderInstance) => forcedModel ?? saved[p.name.split("#")[0]] ?? p.fallbackModel;

    const plan = targets.map((p) => p.name);
    const trail: RouteAttempt[] = [];
    const errors: string[] = [];
    const setupMs = Date.now() - enteredAt;
    // 500ms so the last attempt's result can still be serialised after it returns.
    const remaining = () => deadlineAt - Date.now() - 500;

    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      // Reserve enough of the current deadline for additional providers before starting this one. The
      // timeout applies to the complete response body too, not only headers; otherwise one slow body can
      // still starve every fallback despite a fair header timeout. Fast failures free their unused slice.
      const availableMs = remaining();
      const timeoutMs = routerAttemptTimeoutMs(availableMs, targets.length - i);
      if (timeoutMs < ROUTER_MIN_ATTEMPT_MS) {
        trail.push({ provider: p.name, vendor: p.vendor, model: modelFor(p), pass: 1, timeoutMs: Math.max(0, timeoutMs), ok: false, skipped: true, error: "out of time", ts: Date.now() });
        errors.push(`${p.name}: skipped — ${Math.max(0, availableMs)}ms left`);
        continue;
      }
      const model = modelFor(p);
      try {
        const hit = await attempt(p, model, messages, o, timeoutMs, callCtl.signal);
        // NOT awaited. This is a diagnostic counter, and awaiting it put a network WRITE between a
        // provider answering and the caller receiving the answer — on the success path, every time.
        // Nothing reads it back within the call; a lost increment costs a row in /health, not a result.
        void bumpProviderStats(p.name, true, null, Date.now()).catch(() => {});
        trail.push({ provider: p.name, vendor: p.vendor, model, pass: 1, timeoutMs, ok: true, latencyMs: hit.latencyMs, ts: Date.now() });
        return { ...hit, plan, trail };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        void bumpProviderStats(p.name, false, msg.slice(0, 300), Date.now()).catch(() => {});
        errors.push(`${p.name}: ${msg}`);
        trail.push({ provider: p.name, vendor: p.vendor, model, pass: 1, timeoutMs, ok: false, error: msg.slice(0, 200), ts: Date.now() });
        console.warn(`[SEVERED] ${p.name} (${msg})`);
      }
    }

    // THREE DIFFERENT FAILURES USED TO WEAR ONE MESSAGE, and a live session spent days chasing the wrong
    // one. They still get different text, because the right response differs: add credit, wait, or fix
    // the caller's time accounting.
    const tried = trail.filter((t) => !t.skipped).length;
    const spent = Date.now() - enteredAt;
    const budgetAtEntryMs = Math.round(o.deadlineMs ?? (deadlineAt - enteredAt)) - setupMs;
    // THREE DIFFERENT FAILURES USED TO WEAR ONE MESSAGE, and a live session spent days chasing the wrong
    // one. Simplifying the router is not a licence to re-merge them: the right response still differs —
    // add credit, wait, or fix the caller's time accounting — so they keep distinct codes and text.
    let code: string, cause: string;
    if (tried === 0) {
      code = "NO_BUDGET";
      cause = `NO BUDGET AT ENTRY — zero of ${targets.length} providers were contacted. The caller passed deadlineMs=${o.deadlineMs ?? "(none)"}${o.deadlineAt ? ` deadlineAt=${o.deadlineAt}` : ""}; ${queuedMs}ms went on admission and ${Math.max(0, setupMs - queuedMs)}ms on route setup, leaving ${Math.max(0, remaining())}ms — and an attempt needs ${ROUTER_MIN_ATTEMPT_MS}ms. ${queuedMs >= ROUTER_MIN_ATTEMPT_MS ? "Most of the grant was spent QUEUEING behind other in-flight calls" : "This is the turn's time accounting, NOT a provider problem"}: retrying immediately will fail identically until the caller starts a fresh turn`;
    } else if (tried < targets.length) {
      code = "TIME_EXHAUSTED";
      cause = `ran out of time — tried ${tried}/${targets.length} in ${spent}ms, never reached: ${trail.filter((t) => t.skipped).map((t) => t.provider).join(", ")}`;
    } else {
      code = "EXHAUSTED_ALL";
      cause = `tried all ${targets.length} in ${spent}ms`;
    }
    throw Object.assign(new Error(`ALL_PROVIDERS_EXHAUSTED [${code}] (${cause})\n${errors.join("\n")}`), {
      status: 503, code, errors, plan, trail, tried, total: targets.length,
      elapsedMs: spent, queuedMs, budgetAtEntryMs, callerDeadlineMs: o.deadlineMs ?? null,
    });
  } finally {
    // Armed on the first line; disarmed on every path, including a deadline-cancelled queue wait.
    clearTimeout(callTimer);
    o.signal?.removeEventListener("abort", onCallerAbort);
    if (admitted) release();
  }
}
