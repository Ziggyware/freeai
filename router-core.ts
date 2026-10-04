import { T } from "./timing.ts";
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
 *   · the malformed-secret guard (a key with JSON punctuation never reaches the network)
 *   · empty/dots-only response detection (a 200 OK that is not an answer is a failure)
 *   · the separate body-read budget, now also bounded by the call deadline
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
// FIFO admission rather than a polling spin: waiters resolve in arrival order, with zero timers while
// blocked, so a request that arrived first is never jumped by one that arrived later.
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (inflight < MAX_CONCURRENCY) { inflight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}
function release(): void {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

export type RouteOpts = {
  model?: string; tools?: unknown[]; tool_choice?: unknown;
  temperature?: number; max_tokens?: number; stream?: boolean; response_format?: unknown;
  /** Caller's remaining wall-clock budget for the WHOLE call. Converted to an instant on entry. */
  deadlineMs?: number;
  /** An ABSOLUTE instant (epoch ms) this call must finish by. Preferred: an instant has no origin to
   *  displace, which is the entire class of bug that produced "8964ms granted, 20051ms spent". */
  deadlineAt?: number;
  /** Aborted when the caller gives up; linked into every fetch and body read this call makes. */
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
  // A malformed secret never reaches the network: gemini's `…3, }` key produced 62 identical "Failed to
  // construct 'Request': … not a valid ByteString" failures — thrown by the Request constructor, so it
  // had no HTTP status, was classed retryable, tripped the breaker on a 25s cycle and was retried on
  // every single request forever. It is a config error by definition; say so, and let demotion park it.
  if (p.keyIssue) throw Object.assign(new Error(`KEY_MALFORMED (${p.keyEnv}): ${p.keyIssue}`), { retryable: false, status: 0 });
  const payload: Record<string, unknown> = { model, messages, stream: !!o.stream };
  if (o.max_tokens && o.max_tokens > 0) payload.max_tokens = o.max_tokens;
  if (typeof o.temperature === "number") payload.temperature = o.temperature;
  // tool_choice:"none" with a tools array is semantically "no tools callable" — identical to sending no
  // tools at all — but Groq rejects the combination with HTTP 400 "Tool choice is none, but model called a
  // tool" (seen on every wrap-up pass this session). Send the equivalent form every vendor accepts.
  if (o.tools?.length && o.tool_choice !== "none") { payload.tools = o.tools; if (o.tool_choice) payload.tool_choice = o.tool_choice; }
  if (o.response_format) payload.response_format = o.response_format;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // The attempt's own timer bounds the attempt; the CALL's signal bounds everything, including the body
  // read below, which clears the timer above and would otherwise run on a budget of its own.
  const onCallAbort = () => ctl.abort();
  const unlink = () => callSignal?.removeEventListener("abort", onCallAbort);
  if (callSignal) {
    if (callSignal.aborted) ctl.abort();
    else callSignal.addEventListener("abort", onCallAbort, { once: true });
  }
  const t0 = performance.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "HTTP-Referer": "https://val.town", "X-Title": "Ziggyware-OmniRouter" };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    const res = await fetch(`${p.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal: ctl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const e: any = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      e.retryable = RETRYABLE.has(res.status);
      e.status = res.status;
      throw e;
    }
    // Headers arrived within timeoutMs — that phase is done; clear its timer here, exactly like before
    // content validation existed. CONFIRMED REGRESSION (live /health: anthropic's success rate went from
    // 6/7 to 6/23 after this was added, nearly all new failures API_STALLED_TIMEOUT): keeping the SAME
    // timer armed through the full body read punished large, legitimately-slow-but-completing generations
    // (this app requests up to 16k max_tokens against prompts confirmed 18k+ tokens by a live Groq 413) —
    // a completion that needed even a few seconds past a shrunk, late-pass timeoutMs to finish sending was
    // aborted and misreported as a stall. Body read gets its OWN separate, generous, fixed budget instead —
    // independent of the caller's possibly-tiny remaining timeoutMs — so content validation (which does
    // need the full body) can't retroactively punish a provider that already answered in time.
    if (!o.stream) {
      clearTimeout(timer); unlink();
      // Sized against the attempt cap, not independently: headers clear the attempt timer, so this budget is
      // ADDITIVE on top of it, and 14_000 + 20_000 put a single provider 4 seconds past the 30s ceiling this
      // system is now held to. 15_000 keeps the worst case at 29s. The tradeoff is the one recorded above —
      // a generation that needs more than 15s of body after answering in time is cut — and it is accepted
      // deliberately: work is split per file, so a step generates one file, not a whole app.
      const BODY_READ_TIMEOUT_MS = 15_000;
      let text: string;
      try {
        text = await Promise.race([
          res.text(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error("API_STALLED_TIMEOUT"), { retryable: true, name: "AbortError" })), BODY_READ_TIMEOUT_MS)
          ),
          // The call-wide deadline outranks the body-read budget. Without this the body read is a second,
          // independent clock stacked on top of an attempt that already spent its own — which is exactly
          // how four 4s-capped attempts became 20s of wall time.
          new Promise<never>((_, reject) => {
            if (!callSignal) return;
            if (callSignal.aborted) return reject(Object.assign(new Error("CALL_DEADLINE_REACHED"), { retryable: true, name: "AbortError" }));
            callSignal.addEventListener("abort", () => reject(Object.assign(new Error("CALL_DEADLINE_REACHED"), { retryable: true, name: "AbortError" })), { once: true });
          }),
        ]);
      } catch (e: any) {
        res.body?.cancel().catch(() => {});
        throw e;
      }
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON — let router-openai.ts's own parse surface the real error */ }
      const msg = json?.choices?.[0]?.message;
      if (json && isEmptyOrDotContent(msg)) {
        const e: any = new Error(`EMPTY_OR_DOT_RESPONSE: ${JSON.stringify(String(msg?.content ?? "")).slice(0, 60)}`);
        e.retryable = true;
        throw e;
      }
      return { provider: p, model, latencyMs: Math.round(performance.now() - t0), res: new Response(text, { status: res.status, headers: res.headers }) };
    }
    clearTimeout(timer); unlink();
    return { provider: p, model, latencyMs: Math.round(performance.now() - t0), res };
  } catch (e: any) {
    clearTimeout(timer); unlink();
    // Root cause of a real observed failure: a provider that reliably STALLS (never errors, just never
    // finishes — nemotron-ultra#2/#3 in a live /health dump: 14 and 1 requests, 0 ok, last_error
    // API_STALLED_TIMEOUT on every one) was structurally EXEMPT from demotion. isConfigClass() only ever
    // fires from the res.ok===false branch above (a real HTTP status), so an AbortError never set
    // configClass — report() then reset cfgFails to 0 every time (line "else b.cfgFails = 0"), so the
    // streak needed to demote (CFG_DEAD_AFTER) could never accumulate no matter how many times in a row
    // this exact instance stalled. Each stall still costs up to HARD_TIMEOUT_MS (30s) or
    // BODY_READ_TIMEOUT_MS (20s) of the invocation's 50s wall-clock ceiling — one or two stalling
    // instances sitting at their normal (undemoted) mid-plan position can consume nearly the ENTIRE
    // per-invocation budget, so everything scheduled after them in `targets` (in this case: groq's and
    // openrouter's later key slots) never gets attempted at all, invocation after invocation, because plan
    // order is otherwise stable. Marking this configClass (same as a config-dead 402/403/404) lets it
    // accumulate the same way: `retryable` stays true so the normal 25s breaker still applies unchanged,
    // but after CFG_DEAD_AFTER (2) consecutive stalls with no success in between (any ok=true resets the
    // streak — see report()) it now also gets demoted to the tail for CFG_DEAD_MS, the same relief valve
    // already used for a dead key/model, freeing its prime plan position for providers that answer fast.
    if (e.name === "AbortError") { const t: any = new Error("API_STALLED_TIMEOUT"); t.retryable = true; t.configClass = true; throw t; }
    // Thrown before any bytes left the process (Request/URL construction) ⇒ our configuration, not their
    // outage. Retrying a TypeError is never going to produce a different result.
    if (e instanceof TypeError && /construct|Invalid URL|ByteString/i.test(String(e.message))) { const t = e as any; t.retryable = false; t.configClass = true; }
    if (e.retryable === undefined) e.retryable = true;
    throw e;
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
  // ONE abort for the whole call. Per-attempt timers bound only the phase they arm, and phases here are
  // ADDITIVE — an attempt clears its timer when headers arrive and the body read starts a fresh budget.
  // This signal is armed once, at the deadline, and reaches every fetch and every body read.
  const callCtl = new AbortController();
  const callTimer = setTimeout(() => callCtl.abort(), Math.max(0, deadlineAt - Date.now()));
  const onCallerAbort = () => callCtl.abort();
  o.signal?.addEventListener("abort", onCallerAbort, { once: true });

  await acquire();
  try {
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
    const queuedMs = Date.now() - enteredAt;
    // 500ms so the last attempt's result can still be serialised after it returns.
    const remaining = () => deadlineAt - Date.now() - 500;

    for (const p of targets) {
      // Each attempt gets whatever is left, capped by the hard per-attempt ceiling. No share-of-budget
      // arithmetic: with a roster this size there is nothing to ration, and the arithmetic is what
      // inverted on a small grant (max(4000, 8964/3) = 4000, so four "capped" attempts overran by 2.24x).
      const timeoutMs = Math.min(HARD_TIMEOUT_MS, remaining());
      if (timeoutMs < ROUTER_MIN_ATTEMPT_MS) {
        trail.push({ provider: p.name, vendor: p.vendor, model: modelFor(p), pass: 1, timeoutMs: Math.max(0, timeoutMs), ok: false, skipped: true, error: "out of time", ts: Date.now() });
        errors.push(`${p.name}: skipped — ${Math.max(0, timeoutMs)}ms left`);
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
    const budgetAtEntryMs = Math.round(o.deadlineMs ?? (deadlineAt - enteredAt)) - queuedMs;
    // THREE DIFFERENT FAILURES USED TO WEAR ONE MESSAGE, and a live session spent days chasing the wrong
    // one. Simplifying the router is not a licence to re-merge them: the right response still differs —
    // add credit, wait, or fix the caller's time accounting — so they keep distinct codes and text.
    let code: string, cause: string;
    if (tried === 0) {
      code = "NO_BUDGET";
      cause = `NO BUDGET AT ENTRY — zero of ${targets.length} providers were contacted. The caller passed deadlineMs=${o.deadlineMs ?? "(none)"}${o.deadlineAt ? ` deadlineAt=${o.deadlineAt}` : ""}, of which ${queuedMs}ms went on admission before routing began, leaving ${Math.max(0, remaining())}ms — and an attempt needs ${ROUTER_MIN_ATTEMPT_MS}ms. ${queuedMs >= ROUTER_MIN_ATTEMPT_MS ? "Most of the grant was spent QUEUEING behind other in-flight calls" : "This is the turn's time accounting, NOT a provider problem"}: retrying immediately will fail identically until the caller starts a fresh turn`;
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
    // Armed on the first line; disarmed on every path, including success.
    clearTimeout(callTimer);
    o.signal?.removeEventListener("abort", onCallerAbort);
    release();
  }
}
