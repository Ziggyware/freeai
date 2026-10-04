// ═══════════════════════════════════════════════════════════════════════════
//  ROUTER — the engine: durable routing state, candidate ranking, the attempt
//  loop, and routeChat(). It lives INSIDE the app now; there is no second val, no
//  second deployment, and no HTTP hop between a chat turn and its providers. The
//  protocols on top of it (the OpenAI chat.completions contract and the HTTP
//  routes app.tsx mounts) are in router-api.ts.
//
//  Together with router-api.ts this replaces router-core.ts, router-openai.ts,
//  router-state.ts, router-discover.ts and router.tsx. Five files described one
//  decision — which provider answers next — and two of them (state, discover) had
//  stopped being imported by anything at all. The cooldowns and the live model
//  discovery the README promised were therefore not merely unused, they were
//  unreachable, and had drifted far enough that they no longer type-checked
//  against the catalog they were written for (`p.prefer` and `p.headers` did not
//  exist on the instance type they read them from).
//
//  WHAT THE ROUTER DOES, in one paragraph. A request names a `model` — a
//  meta-model (`auto`, `fast`, `coder`), a vendor (`groq`), a key slot
//  (`groq#2`), or a real upstream id (`openai/gpt-oss-120b`). providers.ts turns
//  that into a candidate set; this file orders it, walks it, and returns the
//  first answer. Ordering is the whole game: the deadline funds roughly three
//  attempts, so WHICH three decides whether a request succeeds at all. They are
//  chosen by tier (never spend money while a free tier is ready), then by quality
//  or by ETA depending on the mode, then by measured health, then round-robin
//  across vendors so three key slots of one rate-limited vendor cannot eat all
//  three attempts. Anything cooling down, holding a malformed secret, or too
//  small for the prompt is not tried at all — it is reported as skipped, with the
//  reason, so a 503 says what to do next.
//
//  KEPT, because each one was paid for in production:
//   · an ABSOLUTE deadline converted to an instant on entry, and one
//     AbortController for the whole call. Budgets cannot be extended by
//     sub-budgets, and a duration measured from a clock that starts after three
//     unbounded awaits is how an 8,964 ms grant once ran for 20,051 ms.
//   · per-candidate time slices covering headers AND the complete non-stream
//     body, so one stalled provider cannot starve every fallback.
//   · cancellable FIFO admission: queueing consumes the same deadline as
//     inference, and nothing waits forever for a routing slot.
//   · malformed-secret detection and the empty/dots-only response check.
//   · durable provider_stats — the only reason any claim in this file about what
//     works can be checked rather than believed.
//
//  RESTORED, because a 25-vendor free-tier roster cannot be walked naively the
//  way a 3-vendor roster could:
//   · per-instance cooldowns (429 / 401 / 402 / 5xx / timeout), durable and
//     merge-on-reload, so a known-dead provider is not retried in the same
//     position on every request forever;
//   · per-model fallback inside a vendor, so one retired id does not take its
//     whole vendor out of the roster;
//   · live `/models` discovery when every listed id is dead — free rosters
//     rotate, and OpenRouter's entire `:free` list changed inside a quarter;
//   · prompt-size and token-budget awareness, so a 4k prompt stops asking a
//     6k-TPM free tier for 16k output tokens and being rejected for it;
//   · parameter pass-through. `reasoning_effort`, `stop`, `top_p` and `seed`
//     were silently dropped between caller and provider, so a reasoning model
//     could never be told to think less when the deadline was short.
// ═══════════════════════════════════════════════════════════════════════════
import { routerAttemptTimeoutMs, T } from "./timing.ts";
import { all, bumpProviderStats, providerStatsAll, run, sql } from "./db.ts";
import {
  clampMaxTokens,
  envNum,
  estimateTokens,
  etaMs,
  instances,
  knownModelValues,
  promptFits,
  quality,
  resolveTargets,
  type Instance,
  type Mode,
  type Tag,
  type TargetSet,
} from "./providers.ts";
// The matrix UI and the HTTP routes are router-api.ts's concern; this module
// decides, it does not serve.

/** Concurrent in-flight routes. This was 3 on a val that did nothing else; it
 *  now shares an isolate with the chat app and its build pipeline, whose swarm
 *  fan-out can legitimately want four lanes at once. Admission below is FIFO and
 *  deadline-cancellable, so this is a throughput decision, never a correctness
 *  one. */
export const MAX_CONCURRENCY = envNum("OMNI_MAX_CONCURRENCY", 4);
export const HARD_TIMEOUT_MS = T.routerHardTimeout;
export const ROUTER_MIN_ATTEMPT_MS = T.routerMinAttempt;
/** Once headers go out on a stream the client owns it, so the call deadline no
 *  longer applies — but a silent connection is still a hung request. This is how
 *  long a stream may produce no bytes at all before it is cut. Previously
 *  nothing bounded a stream body: the attempt's own timer was cleared in a
 *  `finally` the moment headers arrived. */
/** Read per stream rather than once at import. A module-level const means an
 *  operator changing OMNI_STREAM_IDLE_MS waits for an isolate recycle before it
 *  takes effect, and one env lookup against a value that already gates a network
 *  round trip is not a cost worth saving. */
const streamIdleMs = (): number => envNum("OMNI_STREAM_IDLE_MS", T.routerHardTimeout);
/** Model ids tried for one instance: the default, then the catalog's fallbacks,
 *  then a discovered one. Bounded so a vendor whose whole list is retired costs
 *  one slice, not five. */
const MODEL_CHAIN_MAX = 3;
/** Trail entries kept in a response. The last N are what a flowchart needs. */
export const TRAIL_CAP = 60;

// ───────────────────────────────────────────────────────────────────────────
//  COOLDOWNS — how long a known failure keeps an instance out of the ranking
// ───────────────────────────────────────────────────────────────────────────
export const COOL = {
  /** Two consecutive transient failures. Short: a blip should cost one request,
   *  not a minute of capacity. */
  breaker: 3_000,
  /** 429 with no usable retry-after. */
  rate: 8_000,
  /** 429/402 against a per-day quota, or an empty balance. Long: nothing the
   *  router does changes it inside the hour. */
  daily: 3_600_000,
  /** 401/403 — a key or account-tier problem. Not a blip, and hammering it is
   *  how an account gets flagged. */
  auth: 60_000,
  /** Upstream says this model id does not exist. Recorded per (instance, model)
   *  AND per (vendor, model): the vendor is fine, the id is not. */
  model: 3_600_000,
} as const;
const MAX_STRIKES = 2;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// ───────────────────────────────────────────────────────────────────────────
//  DURABLE ROUTING STATE
//
//  One load per STATE_TTL_MS, three queries in parallel, mutated in place and
//  written through WITHOUT awaiting. An awaited write is a network round trip
//  inserted between one provider failing and the next being tried — on the
//  failure path, which is exactly when there is no time to spare.
//
//  Reloads MERGE rather than replace for the safety-critical maps: a cooldown
//  this isolate just set must not be erased by a slightly stale read of the row
//  it is still writing.
// ───────────────────────────────────────────────────────────────────────────
const STATE_TTL_MS = 5_000;
const DISCOVER_TTL_MS = 600_000;

type Cooldown = { until: number; reason: string; fails: number };
type StatRow = { name: string; requests: number; ok: number; failed: number; last_error: string | null; updated_at: number };
type Learned = { lim: number; until: number };

type State = {
  cool: Record<string, Cooldown>;
  /** `@<instance>:<model>` (one key slot's quota) or `<vendor>:<model>` (the id
   *  is gone everywhere) → epoch ms until which it is dead. */
  dead: Record<string, number>;
  /** Learned INPUT ceiling from a real 413 — beats the catalog estimate. */
  capin: Record<string, Learned>;
  /** Learned output throughput, EMA over completions of ≥64 tokens. */
  tps: Record<string, { v: number; n: number }>;
  /** vendor → discovered model id, so a fresh isolate does not re-discover. */
  resolved: Record<string, string>;
  /** vendor → bound model id, written by the matrix UI and /api/update. */
  bound: Record<string, string>;
  stats: Map<string, StatRow>;
};

const emptyState = (): State => ({ cool: {}, dead: {}, capin: {}, tps: {}, resolved: {}, bound: {}, stats: new Map() });
let mem: State = emptyState();
let loadedAt = 0;
let loading: Promise<State> | null = null;

export async function loadState(force = false): Promise<State> {
  if (!force && Date.now() - loadedAt < STATE_TTL_MS) return mem;
  // One flight at a time: N concurrent requests on a cold isolate must not issue
  // N copies of the same three queries.
  if (loading) return loading;
  loading = (async () => {
    const prev = mem;
    const [st, cfg, ps] = await Promise.all([
      all("omni_state", sql`SELECT key, value FROM omni_state WHERE key LIKE 'cool:%' OR key LIKE 'dead:%' OR key LIKE 'capin:%' OR key LIKE 'tps:%' OR key LIKE 'resolved:%'`),
      all("omni_router_config", sql`SELECT provider, selected_model FROM omni_router_config`),
      providerStatsAll(),
    ]);
    const next = emptyState();
    if (st.ok) {
      for (const r of st.value as { key: string; value: string }[]) {
        const i = r.key.indexOf(":");
        if (i < 0) continue;
        const kind = r.key.slice(0, i), id = r.key.slice(i + 1);
        try {
          if (kind === "cool") next.cool[id] = JSON.parse(r.value);
          else if (kind === "dead") next.dead[id] = Number(r.value);
          else if (kind === "capin") next.capin[id] = JSON.parse(r.value);
          else if (kind === "tps") next.tps[id] = JSON.parse(r.value);
          else if (kind === "resolved") next.resolved[id] = r.value;
        } catch { /* one corrupt row must not cost the whole state */ }
      }
    }
    if (cfg.ok) for (const r of cfg.value as { provider: string; selected_model: string }[]) next.bound[r.provider] = r.selected_model;
    if (ps.ok) for (const r of ps.value as StatRow[]) next.stats.set(r.name, r);
    // MERGE on an ordinary reload: keep whichever cooldown/death expires later.
    // Val Town runs many isolates, each with its own copy of this memory, and the
    // database is the only thing they share — so a TTL refresh that replaced
    // instead of merged would drop a cooldown this isolate observed a second ago
    // and had not yet managed to persist, and the router would immediately re-hit
    // the provider that just refused it.
    //
    // A FORCED reload replaces. `force` is only ever passed by invalidateState()
    // and the /api/reset button, and both mean "stop believing what you remember
    // and re-read from scratch". Merging there would keep exactly the entries the
    // operator asked to be rid of, which is how a reset button comes to appear to
    // do nothing.
    const now = Date.now();
    if (!force) {
      for (const [k, c] of Object.entries(prev.cool)) {
        const other = next.cool[k];
        if (c.until > now && (!other || other.until < c.until)) next.cool[k] = c;
      }
      for (const [k, u] of Object.entries(prev.dead)) {
        if (u > now && (next.dead[k] ?? 0) < u) next.dead[k] = u;
      }
    }
    mem = next;
    loadedAt = Date.now();
    loading = null;
    return mem;
  })().catch((e) => {
    // A FAILED read must not be cached: pinning an empty state for the TTL would
    // make every provider look healthy and every binding look unset.
    loading = null;
    console.warn("[router] state load failed, keeping in-memory state:", String((e as Error)?.message ?? e).slice(0, 200));
    return mem;
  });
  return loading;
}

/** /api/update and the settings panel write through these; a change must be
 *  visible on THIS isolate immediately, not after the TTL. */
/** Drop every cached belief so the next call re-reads from the database and from
 *  the vendors themselves. Used by /api/reset and by anything that changed the
 *  roster underneath the engine.
 *
 *  This clears the model cache too, not just the state TTL. A cached upstream
 *  model list and a cached cooldown are the same kind of thing — a belief about
 *  the world that can go stale — and invalidating one while keeping the other
 *  means "reset" leaves the router still choosing model ids it fetched before the
 *  reset, which is precisely the surprise an operator hits a reset button to
 *  avoid. */
export function invalidateState(): void {
  loadedAt = 0;
  modelCache.clear();
  mem.resolved = {};
}

const put = (key: string, value: string) =>
  run(sql`INSERT INTO omni_state (key, value, ts) VALUES (${key}, ${value}, ${Date.now()})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`);
const del = (key: string) => run(sql`DELETE FROM omni_state WHERE key = ${key}`);
/** Never awaited on the routing path. */
const forget = (p: Promise<unknown>) => { void p.catch(() => {}); };

export const coolingUntil = (name: string): number => mem.cool[name]?.until ?? 0;
/** Why an instance is cooling down, for /health and /api/providers. Exposed as a
 *  reader rather than by exporting `mem`: the state object is mutated in place on
 *  the routing path, and a second module holding a reference to it is a second
 *  place that can be wrong about when a write has landed. */
export const cooldownInfo = (name: string): { until: number; reason: string; fails: number } | undefined => mem.cool[name];
export const isCooling = (name: string): boolean => coolingUntil(name) > Date.now();
const deadUntil = (instance: string, vendor: string, model: string): number =>
  Math.max(mem.dead[`@${instance}:${model}`] ?? 0, mem.dead[`${vendor}:${model}`] ?? 0);

/** Model ids worth trying for this instance, best first: an explicit pin, then
 *  the operator's binding, then the catalog order — minus the ones upstream has
 *  already rejected. A pinned id is NEVER filtered: the caller asked for it by
 *  name, and a stale death mark must not silently substitute a different model. */
export function liveModelChain(p: Instance, forced: string | null, now = Date.now()): string[] {
  const bound = mem.bound[p.vendor] ?? mem.bound[p.name];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [forced, bound, mem.resolved[p.vendor], ...p.models]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id !== forced && deadUntil(p.name, p.vendor, id) > now) continue;
    out.push(id);
  }
  return out;
}

export const capInFor = (p: Instance, model: string): number | undefined => {
  const now = Date.now();
  for (const k of [`${p.vendor}:${model}`, `${p.vendor}:*`]) {
    const c = mem.capin[k];
    if (c && c.until > now) return c.lim;
  }
  return undefined;
};
export const tpsFor = (p: Instance, model: string): number | undefined =>
  mem.tps[`${p.vendor}:${model}`]?.v ?? mem.tps[`${p.vendor}:*`]?.v;

function cool(name: string, ms: number, reason: string): void {
  mem.cool[name] = { until: Date.now() + ms, reason, fails: 0 };
  forget(put(`cool:${name}`, JSON.stringify(mem.cool[name])));
}
function strike(name: string, reason: string): void {
  const c = mem.cool[name] ?? { until: 0, reason, fails: 0 };
  c.fails += 1;
  c.reason = reason;
  if (c.fails >= MAX_STRIKES) { c.until = Date.now() + COOL.breaker; c.fails = 0; }
  mem.cool[name] = c;
  forget(put(`cool:${name}`, JSON.stringify(c)));
}
function uncool(name: string): void {
  if (!mem.cool[name]) return;
  delete mem.cool[name];
  forget(del(`cool:${name}`));
}
function markDead(key: string, until: number): void {
  mem.dead[key] = until;
  forget(put(`dead:${key}`, String(until)));
}
/** A real 413 taught us this vendor's actual input ceiling. 24 h: a tier limit,
 *  not a mood. Only ever tightens — a larger learned cap would let the router
 *  re-learn the same 413 on every request. */
function learnCapIn(p: Instance, model: string, promptTokens: number): void {
  const lim = Math.max(256, promptTokens - 1);
  const rec = { lim, until: Date.now() + 86_400_000 };
  for (const k of [`${p.vendor}:${model}`, `${p.vendor}:*`]) {
    if ((mem.capin[k]?.lim ?? Infinity) <= lim) continue;
    mem.capin[k] = rec;
    forget(put(`capin:${k}`, JSON.stringify(rec)));
  }
}
function learnTps(p: Instance, model: string, tokens: number, ms: number): void {
  if (!(tokens >= 64) || !(ms > 200)) return;
  const v = tokens / (ms / 1000);
  for (const k of [`${p.vendor}:${model}`, `${p.vendor}:*`]) {
    const prev = mem.tps[k];
    const next = prev ? { v: prev.v * 0.7 + v * 0.3, n: prev.n + 1 } : { v, n: 1 };
    mem.tps[k] = next;
    forget(put(`tps:${k}`, JSON.stringify(next)));
  }
}
function noteStat(name: string, ok: boolean, err?: string): void {
  // In-memory mirror of the durable counter, so the NEXT request on this isolate
  // ranks against the outcome of this one without waiting for a re-read.
  const s = mem.stats.get(name) ?? { name, requests: 0, ok: 0, failed: 0, last_error: null, updated_at: 0 };
  s.requests++;
  if (ok) s.ok++; else { s.failed++; s.last_error = (err ?? "").slice(0, 300) || s.last_error; }
  s.updated_at = Date.now();
  mem.stats.set(name, s);
}

/** Snapshot for /health and the settings panel. */
export function stateView() {
  const now = Date.now();
  return {
    cooling: Object.entries(mem.cool).filter(([, c]) => c.until > now).map(([name, c]) => ({ name, reason: c.reason, ms_left: c.until - now })),
    dead_models: Object.entries(mem.dead).filter(([, t]) => t > now).map(([k]) => k),
    resolved: mem.resolved,
    bound: mem.bound,
    caps_in: Object.fromEntries(Object.entries(mem.capin).filter(([, c]) => c.until > now).map(([k, c]) => [k, c.lim])),
    tps: Object.fromEntries(Object.entries(mem.tps).filter(([k]) => !k.endsWith(":*")).map(([k, t]) => [k, Math.round(t.v)])),
  };
}

/** Per-instance roster for /health and the scheduled probe. */
export async function getInstanceRoster() {
  await loadState();
  const now = Date.now();
  return instances().map((p) => {
    const s = mem.stats.get(p.name);
    const until = coolingUntil(p.name);
    return {
      name: p.name, vendor: p.vendor, tier: p.tier, slot: p.slot,
      key: p.key ? `${p.keyEnvUsed}…${p.key.slice(-4)}` : (p.keyEnv ? null : "keyless"),
      key_issue: p.keyIssue, model: mem.bound[p.vendor] ?? p.models[0] ?? null,
      // How many of this instance's catalogued model ids are currently known dead
      // upstream. When it equals p.models.length the instance cannot be called at
      // all without discovery — which is what the old router called "demoted", and
      // what the settings panel's urgency sort still needs to see. Reporting the
      // count rather than a boolean keeps a vendor that lost one id of four
      // visibly distinct from one that lost all four.
      dead_models: p.models.filter((m) => deadUntil(p.name, p.vendor, m) > now).length,
      models: p.models.length,
      requests: s?.requests ?? 0, ok: s?.ok ?? 0, failed: s?.failed ?? 0,
      success_rate: s?.requests ? Math.round((s.ok / s.requests) * 100) / 100 : null,
      last_error: s?.last_error ?? null,
      cooling: until > Date.now() ? { ms_left: until - Date.now(), reason: mem.cool[p.name]?.reason ?? "" } : null,
    };
  });
}

export async function resetCooldowns(name = ""): Promise<{ cool: string[]; dead: string[]; capin: string[] }> {
  await loadState();
  const hit = (k: string) => !name || k === name || k.split("#")[0] === name || k.split(":")[0] === name || k.endsWith(`:${name}`);
  const coolKeys = Object.keys(mem.cool).filter(hit);
  const deadKeys = Object.keys(mem.dead).filter((k) => !name || hit(k.replace(/^@/, "")));
  const capinKeys = Object.keys(mem.capin).filter((k) => !name || k.startsWith(`${name}:`));
  for (const k of coolKeys) { delete mem.cool[k]; forget(del(`cool:${k}`)); }
  for (const k of deadKeys) { delete mem.dead[k]; forget(del(`dead:${k}`)); }
  // Learned ceilings go with them: a cap inferred from one malformed request must
  // not survive an operator saying "try again".
  for (const k of capinKeys) { delete mem.capin[k]; forget(del(`capin:${k}`)); }
  for (const v of Object.keys(mem.resolved)) { if (!name || v === name) { delete mem.resolved[v]; forget(del(`resolved:${v}`)); } }
  loadedAt = Date.now();
  return { cool: coolKeys, dead: deadKeys, capin: capinKeys };
}

export async function resetProviderStats(): Promise<void> {
  mem.stats = new Map();
  await run(sql`DELETE FROM provider_stats`).catch(() => {});
}

export async function bindModel(vendor: string, model: string) {
  mem.bound[vendor] = model;
  loadedAt = Date.now(); // stop the TTL re-reading over a write we just made
  return run(sql`INSERT INTO omni_router_config (provider, selected_model) VALUES (${vendor}, ${model})
                 ON CONFLICT(provider) DO UPDATE SET selected_model = excluded.selected_model`);
}
export async function unbindModel(vendor: string) {
  delete mem.bound[vendor];
  loadedAt = Date.now();
  return run(sql`DELETE FROM omni_router_config WHERE provider = ${vendor}`);
}
/** Saved bindings, for /api/providers and /v1/models. */
export async function getSavedModels(): Promise<Record<string, string>> {
  await loadState();
  return { ...mem.bound };
}

// ───────────────────────────────────────────────────────────────────────────
//  ADMISSION — FIFO, and the queue wait is charged to the caller's deadline
// ───────────────────────────────────────────────────────────────────────────
export let inflight = 0;
type Waiter = { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal; onAbort: () => void; active: boolean };
const waiters: Waiter[] = [];

const queueTimeout = () => Object.assign(
  new Error("ROUTER_QUEUE_TIMEOUT: the call deadline expired while waiting for a routing slot"),
  { status: 503, retryable: true, code: "QUEUE_TIMEOUT", kind: "timeout" as const },
);

async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw queueTimeout();
  if (inflight < MAX_CONCURRENCY && waiters.length === 0) { inflight++; return; }
  await new Promise<void>((resolve, reject) => {
    const w: Waiter = {
      resolve, reject, signal, active: true,
      onAbort: () => {
        if (!w.active) return;
        w.active = false;
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        signal.removeEventListener("abort", w.onAbort);
        reject(queueTimeout());
      },
    };
    waiters.push(w);
    signal.addEventListener("abort", w.onAbort, { once: true });
    if (signal.aborted) w.onAbort();
  });
}
function release(): void {
  inflight = Math.max(0, inflight - 1);
  while (waiters.length) {
    const next = waiters.shift()!;
    if (!next.active) continue;
    next.active = false;
    next.signal.removeEventListener("abort", next.onAbort);
    // Reserve the slot BEFORE waking the waiter, or a newly arriving request
    // jumps the queue it was supposed to be behind.
    inflight++;
    next.resolve();
    return;
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  RANKING — which three providers the deadline is going to fund
// ───────────────────────────────────────────────────────────────────────────
export type KeyPolicy = "depth" | "rr" | "breadth";
export type Skipped = { name: string; vendor: string; why: string };

export type RankCtx = {
  mode: Mode;
  tag: Tag | null;
  forcedModel: string | null;
  promptTokens: number;
  expectTokens: number;
  vendorOrder: string[];
  exclude: Set<string>;
  keyPolicy: KeyPolicy;
  now: number;
};

/** Measured reliability in [0,1], decayed toward neutral as the measurement
 *  ages. A 90% rate last month is weaker evidence about now than a 60% rate this
 *  morning — and without the decay a vendor that was broken for a week and has
 *  since been fixed stays at the bottom of the roster forever, which is its own
 *  kind of stale configuration. */
function healthOf(name: string, now: number): number {
  const s = mem.stats.get(name);
  if (!s || !s.requests) return 0.5; // untried is neutral, not guilty
  const smoothed = (s.ok + 2) / (s.requests + 4); // Laplace: 1/1 must not outrank 42/281
  const ageDays = Math.max(0, (now - (s.updated_at || now)) / 86_400_000);
  return 0.5 + (smoothed - 0.5) / (1 + ageDays / 7);
}

/** Excluded by the caller? Matches an instance name, a vendor, or a slot. */
function isExcluded(p: Instance, set: Set<string>): boolean {
  if (!set.size) return false;
  return set.has(p.name.toLowerCase()) || set.has(p.vendor.toLowerCase()) || set.has(p.name.split("#")[0].toLowerCase());
}

const TIER_ORDER: Record<string, number> = { free: 0, credit: 1, paid: 2 };

/** Order the candidate set for THIS request. Pure over (candidates, state, ctx)
 *  — exported so the ranking can be tested without contacting a provider. */
export function rankCandidates(t: TargetSet, ctx: RankCtx): { order: Instance[]; skipped: Skipped[]; models: Map<string, string> } {
  const skipped: Skipped[] = [];
  const models = new Map<string, string>();
  const ready: Instance[] = [];
  const cooling: Instance[] = [];

  for (const p of t.candidates) {
    if (isExcluded(p, ctx.exclude)) { skipped.push({ name: p.name, vendor: p.vendor, why: "excluded by caller" }); continue; }
    if (p.keyIssue) { skipped.push({ name: p.name, vendor: p.vendor, why: `key unusable (${p.keyEnvUsed}): ${p.keyIssue}` }); continue; }
    const chain = liveModelChain(p, ctx.forcedModel, ctx.now);
    if (!chain.length) {
      skipped.push({ name: p.name, vendor: p.vendor, why: `every model id it lists is dead upstream (${p.models[0] ?? "?"}${p.models.length > 1 ? ` +${p.models.length - 1} more` : ""})` });
      continue;
    }
    const model = chain[0];
    if (!promptFits(p, ctx.promptTokens, capInFor(p, model))) {
      // This is the entire point of declaring maxIn: an attempt spent on a
      // guaranteed 413 is an attempt not spent on a provider that could answer.
      const limit = Math.min(p.maxIn ?? Infinity, capInFor(p, model) ?? Infinity);
      skipped.push({ name: p.name, vendor: p.vendor, why: `prompt ≈${ctx.promptTokens} tok exceeds its ${Math.round(limit)} tok input limit — reduce the message size` });
      continue;
    }
    models.set(p.name, model);
    (coolingUntil(p.name) > ctx.now ? cooling : ready).push(p);
  }

  const cmp = (a: Instance, b: Instance): number => {
    const ma = models.get(a.name) ?? a.models[0] ?? "", mb = models.get(b.name) ?? b.models[0] ?? "";
    // 1. An explicit vendor preference outranks everything but readiness. It is
    //    the operator saying what they want; the settings panel's "vendor order"
    //    field is dead weight if the ranking ignores it (which it did).
    if (ctx.vendorOrder.length) {
      const pa = ctx.vendorOrder.indexOf(a.vendor.toLowerCase()), pb = ctx.vendorOrder.indexOf(b.vendor.toLowerCase());
      if (pa !== pb) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
    }
    // 2. The capability the caller asked for.
    if (ctx.tag) {
      const ta = a.tags?.includes(ctx.tag) ? 0 : 1, tb = b.tags?.includes(ctx.tag) ? 0 : 1;
      if (ta !== tb) return ta - tb;
    }
    // 3. Tier. A paid vendor never outranks a ready free one whatever the model
    //    quality: spending money is not the router's call while a free tier
    //    answers.
    const tier = TIER_ORDER[a.tier ?? "free"] - TIER_ORDER[b.tier ?? "free"];
    if (tier) return tier;
    // 4. The mode's own objective. `fast` ranks on the ETA of a COMPLETE reply,
    //    not on throughput alone: a 1200 tps vendor with a 4 s queue is slower
    //    end-to-end than a 300 tps one that answers immediately, and the caller
    //    is waiting on the last token, not the first.
    if (ctx.mode === "latency") {
      const d = etaMs(a, ctx.expectTokens, tpsFor(a, ma)) - etaMs(b, ctx.expectTokens, tpsFor(b, mb));
      if (d) return d;
    }
    const q = quality(mb) - quality(ma);
    if (q) return q;
    // 5. Measured health, then the catalog's own rank, then the key slot.
    const h = healthOf(b.name, ctx.now) - healthOf(a.name, ctx.now);
    if (Math.abs(h) > 1e-9) return h;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.slot - b.slot;
  };

  ready.sort(cmp);
  cooling.sort((a, b) => (coolingUntil(a.name) - coolingUntil(b.name)) || cmp(a, b));

  // Round-robin across vendors, so three key slots of ONE rate-limited vendor
  // cannot consume the three attempts the deadline funds. This is the single
  // highest-value line in the file: with a 14 s budget only ~3 candidates are
  // ever reached, and without interleaving a five-key vendor occupies all three
  // and the request dies inside one provider's outage.
  const spread = (list: Instance[]): Instance[] => {
    if (ctx.keyPolicy === "depth" || list.length < 3) return list;
    const byVendor = new Map<string, Instance[]>();
    for (const p of list) {
      const arr = byVendor.get(p.vendor) ?? [];
      arr.push(p);
      byVendor.set(p.vendor, arr);
    }
    if (ctx.keyPolicy === "rr") {
      // Least-used account first: spreads a per-account daily quota across every
      // key instead of exhausting slot 0 while slots 1..n sit at zero requests.
      for (const arr of byVendor.values()) arr.sort((a, b) => (mem.stats.get(a.name)?.requests ?? 0) - (mem.stats.get(b.name)?.requests ?? 0));
    }
    const groups = [...byVendor.values()];
    const out: Instance[] = [];
    for (let i = 0; out.length < list.length; i++) {
      let progressed = false;
      for (const g of groups) if (i < g.length) { out.push(g[i]); progressed = true; }
      if (!progressed) break;
    }
    return out;
  };

  // Cooling instances go last but are NOT dropped: when everything is cooling an
  // advisory cooldown is still worth ignoring, and giving up with providers
  // untried is worse than trying one that failed eight seconds ago.
  return { order: [...spread(ready), ...spread(cooling)], skipped, models };
}

// ───────────────────────────────────────────────────────────────────────────
//  LIVE MODEL DISCOVERY
//
//  Free rosters rotate. When every id a vendor lists is dead upstream, ask the
//  vendor what it serves today and take the first match for its `prefer` regex.
//  Cached per isolate and persisted, so this costs one request per vendor per
//  ten minutes rather than one per route.
// ───────────────────────────────────────────────────────────────────────────
/** Never "discover" a non-chat endpoint: guards, moderation, ASR, TTS,
 *  embeddings, rerankers and image models all answer /models and none of them
 *  can complete a chat. */
const JUNK_MODEL = /guard|safeguard|moderat|whisper|tts|speech|embed|rerank|playai|vision-only|ocr|\bstt\b|dalle|flux|stable-diffusion|sora|transcri/i;
const modelCache = new Map<string, { ids: string[]; at: number }>();

export function headersFor(p: Instance): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    // Attribution OpenRouter and several aggregators ask for. Harmless elsewhere
    // — and previously applied on the discovery path only, so the calls that
    // needed them most were the ones that did not send them.
    "HTTP-Referer": "https://val.town",
    "X-Title": "Ziggyware-OmniRouter",
    ...(p.headers ?? {}),
  };
  if (p.key) h.Authorization = `Bearer ${p.key}`;
  return h;
}

/** Upstream `/models`, cached. `timeoutMs` bounds it: an unbounded fan-out here
 *  is how a status endpoint hangs for as long as its slowest vendor. */
export async function listUpstreamModels(p: Instance, timeoutMs = 8_000, force = false): Promise<string[]> {
  const c = modelCache.get(p.vendor);
  // `force` is what makes /v1/models?refresh=1 mean something: without it the
  // endpoint re-read its own cache and reported a refresh it never performed.
  if (!force && c && Date.now() - c.at < DISCOVER_TTL_MS) return c.ids;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(`${p.baseResolved}/models`, { headers: headersFor(p), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const ids = ((data?.data ?? data) as any[])
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter((x): x is string => typeof x === "string" && !!x);
    modelCache.set(p.vendor, { ids, at: Date.now() });
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

/** First live id matching the vendor's `prefer` that is not dead and is not
 *  obviously not a chat model. */
export async function discoverModel(p: Instance, timeoutMs = 4_000, now = Date.now()): Promise<string | null> {
  if (!p.prefer) return null;
  const cached = mem.resolved[p.vendor];
  if (cached && deadUntil(p.name, p.vendor, cached) <= now) return cached;
  try {
    const ids = await listUpstreamModels(p, timeoutMs);
    if (!ids.length) return null;
    const rx = new RegExp(p.prefer, "i");
    const pick = ids.find((id) => rx.test(id) && !JUNK_MODEL.test(id) && deadUntil(p.name, p.vendor, id) <= now) ?? null;
    if (pick) {
      mem.resolved[p.vendor] = pick;
      forget(put(`resolved:${p.vendor}`, pick));
    }
    return pick;
  } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────────
//  REQUEST SHAPING
// ───────────────────────────────────────────────────────────────────────────
/** OpenAI parameters forwarded verbatim. Everything here is part of the public
 *  chat.completions contract and the README has always promised it passes
 *  through. */
export const FORWARD_PARAMS = [
  "top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "n",
  "logprobs", "top_logprobs", "user", "metadata", "parallel_tool_calls", "stream_options",
  "service_tier", "store", "reasoning_effort", "reasoning", "thinking", "top_k",
  "repetition_penalty", "prediction", "web_search_options", "modalities",
] as const;
/** Names a 400 may accuse. Only these are ever dropped, and only when the
 *  upstream text actually names them. */
const DROPPABLE: string[] = [...FORWARD_PARAMS, "tools", "tool_choice", "response_format", "max_tokens", "max_completion_tokens"];

export type RouteOpts = {
  model?: string | null;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  temperature?: number;
  max_tokens?: number;
  /** Which name the output ceiling goes out under. OpenAI's gpt-5/o-series
   *  reject `max_tokens` outright; most everyone else has never heard of
   *  `max_completion_tokens`. Guessing wrong is a 400 on every call. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  stream?: boolean;
  /** Caller's remaining wall-clock for the WHOLE call. Re-based to an instant on entry. */
  deadlineMs?: number;
  /** Preferred: an ABSOLUTE epoch ms. A duration has to be measured from
   *  somewhere, and "somewhere" moves with transport time. */
  deadlineAt?: number;
  signal?: AbortSignal;
  /** Everything else OpenAI defines, forwarded as sent. */
  extra?: Record<string, unknown>;
  /** Expected reply length in tokens — sizes the ETA that `fast` ranks on. */
  expectTokens?: number;
  keyPolicy?: KeyPolicy | null;
  vendorOrder?: string[];
  exclude?: string[];
};

/** What a 400 told us to stop sending. Null when the complaint is not about a
 *  parameter we can drop.
 *
 *  Matched on word boundaries, never as a substring. `n` is a real OpenAI
 *  parameter (how many completions to return) and also a letter of the alphabet:
 *  a substring match accused `n` of every complaint containing "not supported",
 *  "unknown" or "invalid", so the repair retry dropped the caller's `n` alongside
 *  the parameter actually at fault — two parameters lost from an error message
 *  that named one. */
const PARAM_WORD = new Map<string, RegExp>();
function paramWord(p: string): RegExp {
  let re = PARAM_WORD.get(p);
  if (!re) {
    // Explicit boundary classes rather than \b: parameter names are snake_case and
    // kebab-case, and \b treats `_` as a word character but `-` as punctuation, so
    // `top_p` and `top-p` would not match consistently under one rule.
    re = new RegExp(`(?<![A-Za-z0-9_-])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "i");
    PARAM_WORD.set(p, re);
  }
  return re;
}

function accusedParams(status: number, text: string): string[] {
  if (status !== 400 && status !== 422) return [];
  if (!/unsupported|not supported|does not support|unknown|invalid|unexpected|cannot (?:be used|combine)|must be|should not|disallowed/i.test(text)) return [];
  return DROPPABLE.filter((p) => paramWord(p).test(text));
}

type FailKind = "auth" | "rate" | "daily" | "model" | "size" | "param" | "server" | "config" | "empty" | "timeout" | "network";
type Failure = { message: string; status: number; retryable: boolean; kind: FailKind; retryAfterMs?: number; accused?: string[] };

const MODEL_GONE = /model[^\n]{0,80}(?:not (?:found|exist|available|supported)|does not (?:exist|appear))|no such model|unknown model|unsupported model|invalid_model|model_not_found|is not a valid model|has been deprecated|retired/i;
const SIZE_GONE = /reduce (?:your |the )?(?:message|prompt|input) size|request too large|prompt is too long|too many tokens|context_length_exceeded|maximum context length|exceeds the (?:model'?s? )?(?:context|token) (?:length|limit)|input (?:is )?too long|too long for this model|exceeds.{0,24}max.{0,16}tokens/i;
const DAILY_GONE = /per day|daily (?:limit|quota)|requests per day|\bRPD\b|\bTPD\b|tokens per day|quota (?:exceeded|reset)|insufficient (?:credit|balance|quota|funds)|not enough credit|payment required|billing|exceeded your current quota|out of credits/i;

/** One classification, one place. Three different failures used to wear one
 *  message and a live session spent days chasing the wrong one: the right
 *  response to "add credit", "wait eight seconds" and "your own time accounting
 *  is broken" are not the same response. */
function classify(status: number, text: string, retryAfter: string | null): Failure {
  const base = { message: `HTTP ${status}: ${text.slice(0, 300)}`, status, retryable: RETRYABLE_STATUS.has(status) };
  if (status === 401 || status === 403) return { ...base, kind: "auth", retryable: false };
  if (status === 402) return { ...base, kind: "daily", retryable: false };
  if (status === 429) {
    if (DAILY_GONE.test(text)) return { ...base, kind: "daily", retryable: false };
    const ms = parseRetryAfter(retryAfter, text);
    return { ...base, kind: "rate", ...(ms ? { retryAfterMs: ms } : {}) };
  }
  if (status === 404 || MODEL_GONE.test(text)) return { ...base, kind: "model", retryable: false };
  if (SIZE_GONE.test(text)) return { ...base, kind: "size", retryable: false };
  const accused = accusedParams(status, text);
  if (accused.length) return { ...base, kind: "param", retryable: false, accused };
  if (status >= 500) return { ...base, kind: "server" };
  return { ...base, kind: "config", retryable: false };
}

/** retry-after as seconds or an HTTP date, else a "try again in Ns" in the body.
 *  Capped at ten minutes: a vendor saying "retry in a day" is describing a
 *  `daily` problem, and the caller's deadline is fourteen seconds either way. */
function parseRetryAfter(header: string | null, text: string): number | null {
  const cap = 600_000;
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) return Math.min(cap, Math.round(secs * 1000));
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.max(0, Math.min(cap, when - Date.now()));
  }
  const m = text.match(/(?:try again|retry|resets?) (?:in )?(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)\s*(?:until|before|remaining|left)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = /^[hm]/i.test(m[2]) ? (/^h/i.test(m[2]) ? 3_600_000 : 60_000) : 1000;
  return Number.isFinite(n) ? Math.min(cap, Math.round(n * mult)) : null;
}

// ───────────────────────────────────────────────────────────────────────────
//  ONE ATTEMPT
// ───────────────────────────────────────────────────────────────────────────
export type RouteAttempt = {
  provider: string; vendor: string; model: string;
  /** 1 = the instance's first model id, 2+ = a fallback within the same vendor. */
  pass: number;
  timeoutMs: number; ok: boolean; skipped?: boolean; latencyMs?: number;
  error?: string; dropped?: string[]; ts: number;
};
export type RouteHit = {
  provider: Instance; model: string; latencyMs: number;
  /** Non-stream: the complete upstream body, already read inside the slice. */
  text?: string;
  /** Stream: the live upstream response. Failover is over; the client owns it. */
  res?: Response;
  maxTokensSent: number;
  plan?: string[]; trail?: RouteAttempt[]; skipped?: Skipped[];
};

/** Every route failure carries its trail. A flowchart that shows "everything
 *  tried, then a 503" is strictly more useful than one that goes dark the moment
 *  there is no winner to hang it off. */
export class RouteError extends Error {
  status: number; code: string; errors: string[]; plan: string[]; trail: RouteAttempt[];
  skipped: Skipped[]; tried: number; total: number; elapsedMs: number; queuedMs: number;
  budgetAtEntryMs: number; callerDeadlineMs: number | null; kind: FailKind;
  constructor(message: string, d: {
    status?: number; code?: string; errors?: string[]; plan?: string[]; trail?: RouteAttempt[];
    skipped?: Skipped[]; tried?: number; total?: number; elapsedMs?: number; queuedMs?: number;
    budgetAtEntryMs?: number; callerDeadlineMs?: number | null; kind?: FailKind;
  } = {}) {
    super(message);
    this.name = "RouteError";
    this.status = d.status ?? 503;
    this.code = d.code ?? "ROUTE_FAILED";
    this.errors = d.errors ?? [];
    this.plan = d.plan ?? [];
    this.trail = d.trail ?? [];
    this.skipped = d.skipped ?? [];
    this.tried = d.tried ?? 0;
    this.total = d.total ?? 0;
    this.elapsedMs = d.elapsedMs ?? 0;
    this.queuedMs = d.queuedMs ?? 0;
    this.budgetAtEntryMs = d.budgetAtEntryMs ?? 0;
    this.callerDeadlineMs = d.callerDeadlineMs ?? null;
    this.kind = d.kind ?? "network";
  }
}

function isEmptyOrDotContent(msg: any): boolean {
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) return false;
  // A reasoning model that spent its whole budget thinking returns content:""
  // with the thinking in `reasoning`. That is a TRUNCATED reply, not an empty
  // one, and the caller's auto-continue path handles it — rejecting it here
  // would punish a provider that worked and hide the finish_reason that explains
  // what happened.
  if (typeof msg?.reasoning === "string" && msg.reasoning.trim()) return false;
  if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim()) return false;
  if (typeof msg?.content !== "string") return false;
  const stripped = msg.content.replace(/\s+/g, "");
  return stripped.length === 0 || /^\.+$/.test(stripped);
}

type AttemptArgs = {
  p: Instance;
  messages: unknown[];
  o: RouteOpts;
  /** Absolute epoch ms at which this instance's slice ends. */
  sliceEndsAt: number;
  callSignal: AbortSignal;
  promptTokens: number;
  forced: string | null;
  pass?: number;
  /** Discovery gets one shot per instance, or a vendor whose discovered model is
   *  also rejected would recurse until the deadline. */
  discoveryUsed?: boolean;
};

/** One instance, walked down its own model chain. Handles the two bounded
 *  in-place retries that earn their complexity: a model id upstream no longer
 *  serves (fall through to the vendor's next id), and a parameter upstream
 *  refuses BY NAME (drop exactly that parameter and ask once more). Everything
 *  else propagates to the caller, which decides whether the instance is worth
 *  cooling down. */
async function attemptInstance(a: AttemptArgs): Promise<RouteHit> {
  const { p, messages, o, callSignal } = a;
  const trail: RouteAttempt[] = [];
  const dropped = new Set<string>();
  let pass = a.pass ?? 1;
  let chain = liveModelChain(p, a.forced);
  let paramRetryUsed = false;

  const fail = (message: string, d: { status?: number; kind?: FailKind; retryable?: boolean; code?: string; retryAfterMs?: number }) => {
    const e = new RouteError(message, { ...d, status: d.status ?? 502, kind: d.kind ?? "network", trail });
    (e as any).retryable = d.retryable ?? true;
    // Carried across the throw, because the cooldown decision is made by the
    // caller and the Retry-After header is only visible here. Losing it meant a
    // vendor that said "come back in 30 seconds" was cooled for the flat 8s rate
    // window and retried four times before it was willing to answer again.
    if (d.retryAfterMs) (e as any).retryAfterMs = d.retryAfterMs;
    return e;
  };

  for (;;) {
    const model = chain[0];
    if (!model) break;
    const left = a.sliceEndsAt - Date.now();
    // The first model always gets attempted (the caller's slice was sized for
    // it); a SECOND one needs a full minimum attempt of its own.
    if (trail.length && left < ROUTER_MIN_ATTEMPT_MS) {
      trail.push({ provider: p.name, vendor: p.vendor, model, pass, timeoutMs: Math.max(0, left), ok: false, skipped: true, error: "out of time for another model on this vendor", ts: Date.now() });
      break;
    }
    const timeoutMs = Math.min(HARD_TIMEOUT_MS, Math.max(ROUTER_MIN_ATTEMPT_MS, left));
    const maxTokensSent = clampMaxTokens(p, a.promptTokens, o.max_tokens);
    const field = o.maxTokensField ?? "max_tokens";
    const payload: Record<string, unknown> = { model, messages, stream: !!o.stream };
    payload[field] = maxTokensSent;
    if (typeof o.temperature === "number" && !dropped.has("temperature")) payload.temperature = o.temperature;
    // tool_choice:"none" alongside a tools array is equivalent to sending no
    // tools at all, and Groq rejects the combination outright.
    if (o.tools?.length && o.tool_choice !== "none" && !dropped.has("tools")) {
      payload.tools = o.tools;
      if (o.tool_choice !== undefined && !dropped.has("tool_choice")) payload.tool_choice = o.tool_choice;
    }
    if (o.response_format !== undefined && !dropped.has("response_format")) payload.response_format = o.response_format;
    for (const [k, v] of Object.entries(o.extra ?? {})) {
      if (dropped.has(k) || payload[k] !== undefined) continue;
      payload[k] = v;
    }
    if (dropped.has(field)) delete payload[field];

    const ctl = new AbortController();
    const t0 = performance.now();
    let rejectTimeout!: (r: unknown) => void;
    const timedOut = new Promise<never>((_, rej) => { rejectTimeout = rej; });
    const timer = setTimeout(() => {
      ctl.abort();
      rejectTimeout(Object.assign(new Error("API_STALLED_TIMEOUT"), { retryable: true, name: "AbortError" }));
    }, timeoutMs);
    let rejectCall!: (r: unknown) => void;
    const callEnded = new Promise<never>((_, rej) => { rejectCall = rej; });
    const onCallAbort = () => {
      ctl.abort();
      rejectCall(Object.assign(new Error("CALL_DEADLINE_REACHED"), { retryable: true, name: "AbortError" }));
    };
    const unlink = () => callSignal.removeEventListener("abort", onCallAbort);
    if (callSignal.aborted) onCallAbort();
    else callSignal.addEventListener("abort", onCallAbort, { once: true });
    const within = <X>(work: Promise<X>): Promise<X> => Promise.race([work, timedOut, callEnded]);

    try {
      const res = await within(fetch(`${p.baseResolved}/chat/completions`, {
        method: "POST", headers: headersFor(p), body: JSON.stringify(payload), signal: ctl.signal,
      }));

      if (!res.ok) {
        const body = await within(res.text()).catch(() => "");
        const f = classify(res.status, body, res.headers.get("retry-after"));
        const latencyMs = Math.round(performance.now() - t0);

        // ── the id is gone: walk this vendor's own fallback list ──────────────
        if (f.kind === "model" && chain.length > 1 && pass < MODEL_CHAIN_MAX) {
          markDead(`@${p.name}:${model}`, Date.now() + COOL.model);
          markDead(`${p.vendor}:${model}`, Date.now() + COOL.model);
          trail.push({ provider: p.name, vendor: p.vendor, model, pass, timeoutMs, ok: false, latencyMs, error: f.message.slice(0, 200), ts: Date.now() });
          chain = chain.slice(1);
          pass++;
          continue;
        }
        // ── upstream named a parameter it will not accept: drop it, ask once ──
        if (f.kind === "param" && f.accused?.length && !paramRetryUsed) {
          const newly = f.accused.filter((x) => !dropped.has(x));
          if (newly.length) {
            paramRetryUsed = true;
            for (const x of newly) dropped.add(x);
            trail.push({ provider: p.name, vendor: p.vendor, model, pass, timeoutMs, ok: false, dropped: newly, latencyMs, error: `${f.message.slice(0, 160)} — retrying without ${newly.join(", ")}`, ts: Date.now() });
            continue; // same model, same slice, one repair only
          }
        }
        clearTimeout(timer);
        unlink();
        throw fail(f.message, { status: f.status, kind: f.kind, retryable: f.retryable, retryAfterMs: f.retryAfterMs });
      }

      if (o.stream) {
        // Failover is over the moment headers arrive: after this the client owns
        // the stream. The attempt timeout and the call deadline are both
        // released — a legitimate long stream would otherwise be cut at the
        // route deadline — and an IDLE watchdog takes over, because a silent
        // connection is still a hung request.
        clearTimeout(timer);
        unlink();
        return { provider: p, model, latencyMs: Math.round(performance.now() - t0), res: watchIdle(res, ctl), maxTokensSent, trail };
      }

      // The same slice bounds headers AND the complete body. Without that, one
      // fast header followed by a stalled body consumes the entire shared
      // deadline and starves every fallback provider.
      const text = await within(res.text());
      clearTimeout(timer);
      unlink();
      const latencyMs = Math.round(performance.now() - t0);
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* handled below */ }
      if (json === null) throw fail(`MALFORMED_UPSTREAM_REPLY: ${text.slice(0, 200)}`, { status: 502, kind: "server" });
      if (!Array.isArray(json?.choices) || !json.choices.length) {
        // A vendor that answers 200 with an error object instead of choices is
        // not a success, and accepting it here is how an empty reply reaches the
        // user wearing a provider's own apology as its content.
        const upstreamErr = json?.error?.message ?? json?.message ?? json?.detail;
        throw fail(upstreamErr ? `HTTP 200 with an error body: ${String(upstreamErr).slice(0, 200)}` : `NO_CHOICES: ${text.slice(0, 200)}`, { status: 502, kind: "server" });
      }
      if (isEmptyOrDotContent(json.choices[0]?.message)) {
        throw fail(`EMPTY_OR_DOT_RESPONSE: ${JSON.stringify(String(json.choices[0]?.message?.content ?? "")).slice(0, 60)}`, { status: 502, kind: "empty" });
      }
      learnTps(p, model, Number(json?.usage?.completion_tokens) || 0, latencyMs);
      return { provider: p, model, latencyMs, text, maxTokensSent, trail };
    } catch (e: any) {
      clearTimeout(timer);
      unlink();
      if (e instanceof RouteError) throw e;
      if (callSignal.aborted || e?.message === "CALL_DEADLINE_REACHED") {
        throw fail("CALL_DEADLINE_REACHED", { status: 503, kind: "timeout", code: "CALL_DEADLINE" });
      }
      if (e?.name === "AbortError" || e?.message === "API_STALLED_TIMEOUT") {
        throw fail(`API_STALLED_TIMEOUT: no complete response within ${timeoutMs}ms`, { status: 504, kind: "timeout" });
      }
      // Invalid URL / header construction is local configuration, not an outage:
      // a missing CF_ACCOUNT_ID must not be reported as a provider being down.
      if (e instanceof TypeError && /construct|Invalid URL|ByteString|Failed to parse/i.test(String(e.message))) {
        throw fail(`CONFIG: ${String(e.message).slice(0, 200)} — check this vendor's base URL and the env vars it interpolates`, { status: 0, kind: "config", retryable: false });
      }
      throw fail(`NETWORK: ${String(e?.message ?? e).slice(0, 200)}`, { status: 0, kind: "network" });
    } finally {
      // Safety net: the try/catch above clears on every path it returns or throws
      // from, and a stream deliberately hands `ctl` to the idle watchdog. This
      // only fires if something throws before either happens.
      clearTimeout(timer);
      unlink();
    }
  }

  // Every id this vendor lists is dead upstream. Ask it what it serves today —
  // bounded, cached, and only with time left in the slice.
  if (!a.discoveryUsed) {
    const left = a.sliceEndsAt - Date.now();
    if (left > ROUTER_MIN_ATTEMPT_MS + 2_500) {
      const found = await discoverModel(p, Math.min(4_000, left - ROUTER_MIN_ATTEMPT_MS));
      if (found) {
        const retry = await attemptInstance({ ...a, forced: found, pass: pass + 1, discoveryUsed: true });
        retry.trail = [...trail, ...(retry.trail ?? [])];
        return retry;
      }
    }
  }
  throw fail(
    `MODEL_UNAVAILABLE on ${p.name}: every model id it lists was rejected upstream${trail.length ? ` — last: ${trail[trail.length - 1].error ?? ""}` : ""}`,
    { status: 404, kind: "model", retryable: false },
  );
}

/** Cut a stream that stops producing. The attempt's own AbortController is
 *  reused, so the underlying fetch is cancelled rather than merely unread. */
function watchIdle(res: Response, ctl: AbortController): Response {
  const body = res.body;
  if (!body) return res;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { ctl.abort(); } catch { /* already gone */ } }, streamIdleMs());
  };
  // `cancel` is part of the Transformer contract in Deno and in the WHATWG
  // streams spec; some TS lib builds omit it from the type, hence the cast. It is
  // the branch that fires when the CLIENT hangs up, and without it a disconnected
  // reader leaves the idle timer armed on an isolate that has nothing left to do.
  const transformer = {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) { arm(); controller.enqueue(chunk); },
    flush() { if (timer) clearTimeout(timer); },
    cancel() { if (timer) clearTimeout(timer); },
  };
  const out = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(transformer as any));
  arm();
  return new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ───────────────────────────────────────────────────────────────────────────
//  THE ROUTE
// ───────────────────────────────────────────────────────────────────────────
export async function routeChat(messages: unknown[], o: RouteOpts = {}): Promise<RouteHit> {
  // The clock starts on the FIRST line and is an INSTANT. A duration has to be
  // measured from somewhere, and "somewhere" used to be after acquire() and two
  // DB round trips — so the router honoured its deadline perfectly against an
  // origin seconds later than the caller's.
  const enteredAt = Date.now();
  const hardCeiling = enteredAt + T.routerCeiling;
  const deadlineAt = Math.min(
    hardCeiling,
    typeof o.deadlineAt === "number" && Number.isFinite(o.deadlineAt)
      ? o.deadlineAt
      : o.deadlineMs && o.deadlineMs > 0 ? enteredAt + o.deadlineMs : hardCeiling,
  );
  const callCtl = new AbortController();
  const callTimer = setTimeout(() => callCtl.abort(), Math.max(0, deadlineAt - Date.now()));
  const onCallerAbort = () => callCtl.abort();
  if (o.signal?.aborted) callCtl.abort();
  else o.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let admitted = false;
  try {
    const live = instances();
    if (!live.length) {
      throw new RouteError(
        "NO_PROVIDERS_CONFIGURED: no catalog vendor has a usable key. Set one of the *_API_KEY variables listed by GET /api/providers, or add a vendor with OMNI_PROVIDERS.",
        { status: 503, code: "NO_PROVIDERS", kind: "config" },
      );
    }
    const promptTokens = estimateTokens(messages, o.tools);
    const target = resolveTargets(o.model, live);
    if (!target.candidates.length) {
      throw new RouteError(
        `UNKNOWN_MODEL: "${o.model}" is not a vendor, a key slot, a routing tag, or a model id any configured vendor serves. Refusing to guess — an answer from a different model is indistinguishable from the one you asked for misbehaving.`,
        { status: 404, code: "UNKNOWN_MODEL", kind: "config", plan: knownModelValues(live).slice(0, 120) },
      );
    }

    await acquire(callCtl.signal);
    admitted = true;
    const queuedMs = Date.now() - enteredAt;
    await loadState();

    const ctx: RankCtx = {
      mode: target.mode,
      tag: target.tag,
      forcedModel: target.forcedModel,
      promptTokens,
      expectTokens: o.expectTokens ?? (promptTokens > 2000 ? 6000 : 1500),
      vendorOrder: (o.vendorOrder ?? []).map((v) => v.toLowerCase()),
      exclude: new Set((o.exclude ?? []).map((v) => v.toLowerCase())),
      keyPolicy: o.keyPolicy ?? "breadth",
      now: Date.now(),
    };
    const ranked = rankCandidates(target, ctx);
    const order = ranked.order;
    const trail: RouteAttempt[] = [];
    const errors: string[] = [];
    const skipped = [...ranked.skipped];
    const plan = order.map((p) => p.name);
    const setupMs = Date.now() - enteredAt;

    if (!order.length) {
      // Every candidate was skipped for a reason the caller can act on. The
      // prompt-too-large case gets its own status and its own wording, so the
      // client shrinks the prompt instead of resending an identical, unwinnable
      // request four times — which is precisely what it used to do.
      const allSize = skipped.every((s) => /input limit|reduce the message size/.test(s.why));
      const limits = live
        .filter((p) => !isExcluded(p, ctx.exclude))
        .map((p) => Math.min(p.maxIn ?? Infinity, capInFor(p, p.models[0] ?? "") ?? Infinity))
        .filter(Number.isFinite);
      const widest = limits.length ? Math.round(Math.max(...limits)) : 0;
      throw new RouteError(
        allSize
          ? `PROMPT_TOO_LARGE: ≈${promptTokens} tokens, and the widest input limit among configured vendors is ${widest || "unknown"}. Reduce the message size — drop older history or trim tool output — and retry.`
          : `NO_ELIGIBLE_PROVIDER: ${skipped.length} candidate(s) skipped without being called:\n${skipped.slice(0, 30).map((s) => `  · ${s.name}: ${s.why}`).join("\n")}`,
        {
          status: allSize ? 413 : 503, code: allSize ? "PROMPT_TOO_LARGE" : "NO_ELIGIBLE_PROVIDER",
          kind: "config", errors: skipped.map((s) => `${s.name}: ${s.why}`), plan, trail, skipped,
          total: target.candidates.length, elapsedMs: Date.now() - enteredAt, queuedMs,
        },
      );
    }

    // 500 ms held back so the last attempt's result can still be serialised.
    const remaining = () => deadlineAt - Date.now() - 500;

    for (let i = 0; i < order.length; i++) {
      const p = order[i];
      const availableMs = remaining();
      const timeoutMs = routerAttemptTimeoutMs(availableMs, order.length - i);
      const model = ranked.models.get(p.name) ?? p.models[0] ?? "";
      if (timeoutMs < ROUTER_MIN_ATTEMPT_MS) {
        trail.push({ provider: p.name, vendor: p.vendor, model, pass: 1, timeoutMs: Math.max(0, timeoutMs), ok: false, skipped: true, error: "out of time", ts: Date.now() });
        errors.push(`${p.name}: skipped — ${Math.max(0, Math.round(availableMs))}ms left and an attempt needs ${ROUTER_MIN_ATTEMPT_MS}ms`);
        continue;
      }
      try {
        const hit = await attemptInstance({
          p, messages, o, sliceEndsAt: Date.now() + timeoutMs,
          callSignal: callCtl.signal, promptTokens, forced: ctx.forcedModel,
        });
        if (hit.trail?.length) trail.push(...hit.trail);
        // NOT awaited. This is a diagnostic counter, and awaiting it puts a
        // network WRITE between a provider answering and the caller receiving
        // the answer — on the success path, every time.
        forget(bumpProviderStats(p.name, true, null, Date.now()));
        noteStat(p.name, true);
        uncool(p.name);
        trail.push({ provider: p.name, vendor: p.vendor, model: hit.model, pass: 1, timeoutMs, ok: true, latencyMs: hit.latencyMs, ts: Date.now() });
        return { ...hit, plan, trail, skipped };
      } catch (e: any) {
        if (Array.isArray(e?.trail)) trail.push(...(e.trail as RouteAttempt[]).filter((x) => !x.ok));
        const msg = String(e?.message ?? e);
        const kind: FailKind = e?.kind ?? "network";
        const status = Number(e?.status) || 0;
        forget(bumpProviderStats(p.name, false, msg.slice(0, 300), Date.now()));
        noteStat(p.name, false, msg);

        // What this failure teaches the next request. "model" and "param" are not
        // the INSTANCE's fault — the model death was already recorded per id, and
        // a dropped parameter was repaired in place — so neither cools it down.
        if (kind === "auth") cool(p.name, COOL.auth, `HTTP ${status} — key or account tier`);
        else if (kind === "daily") cool(p.name, COOL.daily, `HTTP ${status} — quota or balance exhausted`);
        else if (kind === "rate") cool(p.name, Math.max(COOL.rate, e?.retryAfterMs ?? 0), `HTTP 429${e?.retryAfterMs ? ` — retry after ${Math.round(e.retryAfterMs / 1000)}s` : ""}`);
        else if (kind === "size") learnCapIn(p, model, promptTokens);
        else if (kind === "timeout" || kind === "server" || kind === "network" || kind === "empty") strike(p.name, `${kind}${status ? ` HTTP ${status}` : ""}`);

        errors.push(`${p.name}: ${msg}`);
        trail.push({ provider: p.name, vendor: p.vendor, model, pass: 1, timeoutMs, ok: false, error: msg.slice(0, 200), ts: Date.now() });
        console.warn(`[router] ${p.name} (${model}) → ${msg.slice(0, 160)}`);

        // A spent call deadline ends the route: the next provider cannot help.
        if (callCtl.signal.aborted) break;
      }
    }

    const tried = trail.filter((t) => !t.skipped).length;
    const spent = Date.now() - enteredAt;
    let code: string, cause: string;
    if (tried === 0) {
      code = "NO_BUDGET";
      cause = `NO BUDGET AT ENTRY — zero of ${order.length} ranked providers were contacted. The caller passed deadlineMs=${o.deadlineMs ?? "(none)"}${o.deadlineAt ? ` deadlineAt=${o.deadlineAt}` : ""}; ${queuedMs}ms went on admission and ${Math.max(0, setupMs - queuedMs)}ms on route setup, leaving ${Math.max(0, Math.round(remaining()))}ms — and an attempt needs ${ROUTER_MIN_ATTEMPT_MS}ms. ${queuedMs >= ROUTER_MIN_ATTEMPT_MS ? "Most of the grant was spent QUEUEING behind other in-flight calls" : "This is the turn's time accounting, NOT a provider problem"}: retrying immediately fails identically until the caller starts a fresh turn`;
    } else if (tried < order.length) {
      code = "TIME_EXHAUSTED";
      const never = trail.filter((t) => t.skipped && t.error === "out of time").map((t) => t.provider);
      cause = `ran out of time — tried ${tried}/${order.length} in ${spent}ms${never.length ? `, never reached: ${never.join(", ")}` : ""}`;
    } else {
      code = "EXHAUSTED_ALL";
      cause = `tried all ${order.length} in ${spent}ms`;
    }
    throw new RouteError(
      `ALL_PROVIDERS_EXHAUSTED [${code}] (${cause})\n${errors.join("\n")}${skipped.length ? `\nskipped without a call: ${skipped.slice(0, 20).map((s) => `${s.name} (${s.why})`).join("; ")}` : ""}`,
      {
        status: 503, code, kind: "server", errors, plan, trail, skipped, tried, total: order.length,
        elapsedMs: spent, queuedMs,
        budgetAtEntryMs: Math.round(o.deadlineMs ?? (deadlineAt - enteredAt)) - setupMs,
        callerDeadlineMs: o.deadlineMs ?? null,
      },
    );
  } finally {
    // Armed on the first line; disarmed on every path, including a
    // deadline-cancelled queue wait. For a stream the slot is released here, at
    // header time: the guard is on concurrent inference STARTS, and a long-lived
    // stream should not hold a lane hostage while it dribbles tokens out.
    clearTimeout(callTimer);
    o.signal?.removeEventListener("abort", onCallerAbort);
    if (admitted) release();
  }
}

/** Is this a router exhaustion the caller should treat as "start a fresh turn"
 *  rather than "give up"? The work already done is persisted either way. */
export const isExhaustion = (e: any): boolean =>
  e instanceof RouteError || ["EXHAUSTED_ALL", "TIME_EXHAUSTED", "NO_BUDGET", "NO_PROVIDERS", "QUEUE_TIMEOUT"].includes(e?.code);
