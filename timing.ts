// EVERY TIMEOUT IN THE SYSTEM, IN ONE PLACE, KEYED BY THE CONTEXT IT APPLIES TO.
//
// Why this file exists, concretely: app-infer.ts's retry loop refused to retry with less than a literal
// 4000ms left, while router-core.ts refused to contact a provider with less than 5000. Every remaining
// budget in that 1000ms-wide window produced a retry that reached ZERO of 34 providers, and the user was
// shown "ALL_PROVIDERS_EXHAUSTED" — a provider-shaped message for two constants in two files disagreeing
// by 1000ms. That is not a bug you fix once; it is a bug you make unrepresentable, by giving the numbers
// one home and asserting the relationships between them.
//
// NOTHING here is a magic number except the PLATFORM block, which is measured fact about Val Town. Every
// other value is derived from those facts or from the context's own clock, and every derivation is
// checked by assertTimingInvariants() — which the test suite runs, so a change that makes two numbers
// disagree fails there instead of in production three weeks later.
//
// OVERRIDES. Any value may be overridden per deployment with an environment variable, because the right
// number depends on the plan you are on: OMNI_T_PER_CALL_MAX=15000, OMNI_T_RESPONSE_DEADLINE=50000, and
// so on — the env name is OMNI_T_ plus the key in SCREAMING_SNAKE_CASE. An override that breaks an
// invariant is REJECTED at load with a message naming the invariant, rather than silently reintroducing
// the class of bug this file exists to prevent.

const env = (name: string): number | null => {
  try {
    const raw = (globalThis as any).Deno?.env?.get?.(name);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch { return null; } // env access can throw under a restricted permission set
};
const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/** MEASURED FACTS about the runtime. The only numbers here that are not derived from something else. */
export const PLATFORM = {
  /** Val Town kills an HTTP invocation at roughly this point, with NO response sent — worse than a 503. */
  invocationKillMs: 60_000,
  /** Val Town kills an interval (cron) run at roughly the same point. */
  intervalKillMs: 60_000,
};

type Keys = keyof typeof BASE;
/* RESIZED 2026-09-21 — every unit of work now fits well inside one invocation, with margin.
 *
 *  The old table was sized at the platform ceiling rather than below it: a 45s tick, a 55s response
 *  deadline, a 30s router hard timeout, 30s build/plan/design steps. Nothing in it was individually
 *  wrong, and every invariant below held — but a "step" meant "most of an invocation", so one slow
 *  provider or one long generation consumed the whole thing and the queue made no progress. Measured
 *  the night before this change, one request spent 51 of its first 52 seconds inside two attempts
 *  against a single 550B model.
 *
 *  The ceiling that forces the rest: invariants 4 and 3 together give 2 x perCallMax <= responseDeadline
 *  (a call that may still START must also be able to FINISH), and invariant 7 gives
 *  perCallMax >= routerMinAttempt x routerMinAttempts + transportMargin. So a sub-30s response deadline
 *  is only reachable by lowering routerMinAttempt to 4s: 4000x3 + 2000 = 14000 = perCallMax, and
 *  2 x 14000 = 28000 <= 29000. Every number below is derived from that, not chosen independently.
 *
 *  Nothing may exceed 30s now, and the largest work step is 20s. */
const BASE = {
  // ── the request envelope ────────────────────────────────────────────────────────────────────────
  /** When the app gives up and answers by itself. Must land before invocationKillMs with room to
   *  serialize, or the platform kills the request and the user gets an unreadable gateway page. */
  responseDeadline: 29_000,
  /** Wall clock a chat turn may spend on inference. The rest of the deadline is returnReserve. */
  chatTurnBudget: 20_000,
  /** Never spent on inference: persistence, lint, JSON serialization, the response itself. */
  returnReserve: 6_000,

  // ── one model call ──────────────────────────────────────────────────────────────────────────────
  /** The most any single model call may take, however much its caller has left. One slow vendor must
   *  not be able to consume a whole request. */
  perCallMax: 14_000,
  /** Below this a model call is not worth starting. */
  minCall: 6_000,
  /** The most a single tool call may take. Tools were unbounded until one hung request proved it. */
  toolMax: 14_000,

  // ── the router ──────────────────────────────────────────────────────────────────────────────────
  /** The least time one provider attempt is worth starting with. app-infer.ts's retry loop must know
   *  this number — not a number of its own — before handing the router "whatever is left". */
  routerMinAttempt: 4_000,
  /** What a caller spends around a router call that the router's own clock never sees: serializing,
   *  the request, reading the response back. Reserved on both sides of every budget decision. */
  transportMargin: 2_000,
  /** The router's own ceiling for one whole routeInference call, independent of the caller. */
  routerCeiling: 25_000,
  /** The longest one provider is allowed to hold a connection. */
  routerHardTimeout: 14_000,
  /** How many provider attempts a single call must be able to contain. The router caps each attempt at
   *  callDeadline / this, so it is the number that turns a caller's grant into a guarantee: 34 providers
   *  are worthless if the first one may hold the entire budget.
   *
   *  THREE, not four, and the reason is worth stating because it is a real limit rather than a taste:
   *  perCallMax cannot exceed ~20s. The last call a turn may start begins at chatTurnBudget - minCall -
   *  returnReserve = 27s and must END before the 55s response deadline with margin, so 20s is the
   *  ceiling, and 20s holds three 5s attempts plus transport but not four. Wanting more breadth per call
   *  means a bigger response deadline, which the 60s invocation kill forbids — which is precisely why
   *  wide work belongs in scheduled steps, where each step gets a fresh invocation and its own grant. */
  routerMinAttempts: 3,

  // ── the scheduler ───────────────────────────────────────────────────────────────────────────────
  /** The largest budget any caller may pass to tick(). A step declaring more than this can never run. */
  maxTick: 25_000,
  /** A tick never spends its last slice: it still has to record what it just ran. */
  flushReserve: 3_000,
  /** Added to a step's maxMs when leasing it, so a killed isolate's lease outlives the isolate. */
  leaseGrace: 10_000,
  /** What the interval val asks for. */
  cronTick: 25_000,
  /** What a ?build_status poll asks for: this is the engine that drains the queue. */
  pollTick: 25_000,
  /** What a tick inside a user-facing request asks for, when it must also answer quickly. */
  inRequestTick: 25_000,
  /** A tick whose only job is to return immediately; steps too large for it are SKIPPED, never failed. */
  fastTick: 4_000,
} as const;

/** Resolved values, after environment overrides. Read these, never a literal. */
export const T: Record<Keys, number> = (() => {
  const out = { ...BASE } as Record<Keys, number>;
  for (const k of Object.keys(BASE) as Keys[]) {
    const v = env("OMNI_T_" + snake(k));
    if (v !== null) out[k] = v;
  }
  return out;
})();

/** The relationships that must hold between these numbers. Each one, if violated, is a specific failure
 *  that has actually happened in this system — named, so a violation report says what will break. */
export function assertTimingInvariants(t: Record<Keys, number> = T): string[] {
  const bad: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) bad.push(msg); };

  need(t.responseDeadline < PLATFORM.invocationKillMs,
    `responseDeadline (${t.responseDeadline}) must be under the ${PLATFORM.invocationKillMs}ms invocation kill, or the platform answers with a gateway error instead of the app answering`);
  need(t.chatTurnBudget + t.returnReserve <= t.responseDeadline + t.returnReserve,
    `chatTurnBudget (${t.chatTurnBudget}) plus returnReserve must fit the response deadline`);
  need(t.chatTurnBudget - t.minCall - t.returnReserve + t.perCallMax <= t.responseDeadline - t.minCall,
    `the last model call that may START (at chatTurnBudget - minCall - returnReserve) could END past the response deadline`);
  need(t.perCallMax + t.returnReserve <= t.chatTurnBudget,
    `perCallMax (${t.perCallMax}) plus returnReserve (${t.returnReserve}) exceeds chatTurnBudget (${t.chatTurnBudget}) — the first call would consume the whole turn`);
  need(t.minCall < t.perCallMax,
    `minCall (${t.minCall}) must be below perCallMax (${t.perCallMax})`);
  // THE ONE THAT SHIPPED BROKEN: a caller must never hand the router less than an attempt needs.
  need(t.minCall >= t.routerMinAttempt + t.transportMargin,
    `minCall (${t.minCall}) is below routerMinAttempt + transportMargin (${t.routerMinAttempt + t.transportMargin}) — a call the caller thinks is fundable reaches the router with too little, and the router answers NO_BUDGET as if every provider had failed`);
  // THE SECOND ONE THAT SHIPPED BROKEN: a grant must contain more than one attempt, or "try 34
  // providers" is a promise the arithmetic cannot keep.
  need(t.perCallMax >= t.routerMinAttempt * t.routerMinAttempts + t.transportMargin,
    `perCallMax (${t.perCallMax}) cannot contain ${t.routerMinAttempts} attempts of ${t.routerMinAttempt}ms plus ${t.transportMargin}ms of transport — one slow provider consumes the grant and the rest are never contacted, which the caller then reports as running out of its own budget`);
  need(t.routerHardTimeout <= t.routerCeiling,
    `routerHardTimeout (${t.routerHardTimeout}) exceeds the router's own ceiling (${t.routerCeiling})`);
  need(t.routerCeiling < PLATFORM.invocationKillMs,
    `routerCeiling (${t.routerCeiling}) must be under the invocation kill`);
  need(t.maxTick + t.flushReserve <= PLATFORM.intervalKillMs,
    `maxTick (${t.maxTick}) plus flushReserve cannot fit an interval run`);
  need(t.cronTick <= t.maxTick && t.pollTick <= t.maxTick && t.inRequestTick <= t.maxTick,
    `a tick budget exceeds maxTick (${t.maxTick}), so tick() would refuse steps it should run`);
  need(t.fastTick < t.minCall,
    `fastTick (${t.fastTick}) is not meaningfully "fast" relative to a single call`);
  need(t.leaseGrace > 0, "leaseGrace must be positive or a killed isolate's step is re-claimed instantly");
  return bad;
}

const violations = assertTimingInvariants();
if (violations.length) {
  // Refusing at load is the point. A deployment whose overrides break an invariant would otherwise fail
  // later, somewhere else, wearing someone else's error message — which is the entire history of this file.
  throw new Error("timing.ts: invariant violation from environment overrides:\n" + violations.map((v) => "- " + v).join("\n"));
}

/** Re-exported so router-core.ts derives its per-attempt cap from the same number the invariant checks. */
export const ROUTER_MIN_ATTEMPTS = T.routerMinAttempts;

/** WHICH CLOCK OWNS THIS WORK. A chat turn owns the request; a scheduled step owns only its lease. */
export type TimingContext = "chatTurn" | "scheduledStep" | "tool" | "sideCall";

export interface Budget {
  /** total wall clock this context may spend */
  totalMs: number;
  /** the most one model call inside it may take */
  perCallMs: number;
  /** below this, do not start a call */
  minCallMs: number;
  /** never spent on work — kept to record results and answer */
  reserveMs: number;
}

/** The coherent set of numbers for one context, fitted to the clock that context actually owns.
 *
 *  `availableMs` is what the CALLER knows it has: settings.budgetMs for a chat turn, deadline - now for a
 *  scheduled step. Passing it matters — a builder running inside a 30s step used to be handed a meter
 *  built from the 45s chat-turn budget, so it would start a 20s call past the end of its own lease, the
 *  lease would lapse, another isolate would re-claim the step, and the same file was built twice while
 *  the job made no progress. Every context now gets numbers that fit the clock it is actually under. */
export function budgetFor(ctx: TimingContext, availableMs?: number): Budget {
  const ceiling = ctx === "chatTurn" ? T.chatTurnBudget : ctx === "scheduledStep" ? T.maxTick : T.perCallMax + T.returnReserve;
  const total = Math.max(0, Math.min(availableMs ?? ceiling, ceiling));
  // The reserve scales down with the clock: a 12s step cannot hold back 10s and still do anything, but it
  // must hold back enough to write its result. Never below the transport margin.
  const reserve = Math.max(T.transportMargin, Math.min(T.returnReserve, Math.floor(total * 0.25)));
  const perCall = Math.max(T.routerMinAttempt + T.transportMargin, Math.min(T.perCallMax, total - reserve));
  return {
    totalMs: total,
    perCallMs: perCall,
    // A context whose whole budget is small still must not hand the router less than an attempt needs.
    minCallMs: Math.min(T.minCall, perCall),
    reserveMs: reserve,
  };
}

/** How long one scheduled step of each kind may run. Read by registerHandler, never written inline: a
 *  step declaring more than maxTick can never be claimed by any caller, which assertStepMs() catches. */
const STEP_TABLE = {
  // Strictly under chatTurnBudget, always. A scheduled step does not merely do the work — it must also
  // write its result inside its own lease, and a step sized AT the turn budget is a step that can finish
  // generating exactly when its lease lapses, at which point another isolate re-claims it and the same
  // file is built twice while the job reports no progress. That is a failure this system has had.
  design: 18_000, plan: 18_000, build: 18_000, integrate: 18_000,
  diagnose: 15_000, conform: 15_000, supervise: 12_000, verify: 12_000,
  retention: 8_000, verify_file: 6_000, report_blocked: 4_000, noop: 1_000,
} as const;
export type StepKind = keyof typeof STEP_TABLE;
/** Per-kind budgets, overridable as OMNI_T_STEP_BUILD=25000 and so on. */
export const STEP_MS: Record<StepKind, number> = (() => {
  const out = { ...STEP_TABLE } as Record<StepKind, number>;
  for (const k of Object.keys(STEP_TABLE) as StepKind[]) {
    const v = env("OMNI_T_STEP_" + k.toUpperCase());
    if (v !== null) out[k] = v;
  }
  return out;
})();
/** Reading STEP_MS.someTypo yields undefined, and an undefined maxMs makes every budget comparison NaN —
 *  which is false, so the step is claimed with a NaN lease that can never expire. Look kinds up through
 *  this instead: a kind nobody declared is a programming error and says so at registration time. */
export function stepMs(kind: string): number {
  const ms = (STEP_MS as Record<string, number>)[kind];
  if (!Number.isFinite(ms)) throw new Error(`timing.ts: no budget declared for step kind "${kind}" — add it to STEP_TABLE; an undefined maxMs leases the step with a NaN deadline that never expires`);
  return ms;
}

/** Every declared step must fit the largest tick any caller may run, or it is permanently unrunnable. */
export function assertStepMs(steps: Record<string, number> = STEP_MS): string[] {
  return Object.entries(steps)
    .filter(([, ms]) => ms + T.flushReserve > T.maxTick)
    .map(([kind, ms]) => `step "${kind}" declares ${ms}ms, which cannot fit a ${T.maxTick}ms tick with a ${T.flushReserve}ms reserve — it can never be claimed`);
}
