// Step scheduler. The one structural answer to a 50-60s invocation kill: nothing large runs in one
// invocation. Work is decomposed into steps that each fit comfortably inside one tick, persisted, and
// drained across however many ticks it takes. A tick that runs out of budget stops cleanly and the next
// one resumes — no step is ever half-done, because a step is the unit that either completes or retries.
//
// Two drivers, same queue: the interval val (scheduler-cron.ts) on a clock, and any HTTP handler that
// wants to opportunistically drain a step or two. Concurrency between them is safe: claiming is a single
// conditional UPDATE whose rowsAffected IS the claim (the pattern verified for the breaker state machine),
// and a lease derived from the kill deadline means a step orphaned by a killed isolate self-releases with
// no reaper process — the isolate that held it is guaranteed dead by the time the lease lapses.
import { T } from "./timing.ts";
import { all, type Bound, one, run, sql } from "./db.ts";

export const MAX_ATTEMPTS = 4;
export const LEASE_GRACE_MS = T.leaseGrace;
const FLUSH_RESERVE_MS = T.flushReserve; // never spend the last of the budget; the tick still has to record results
/** The largest budget any caller may pass to tick(). Val Town kills an invocation at ~60s, so 45s is the
 *  practical ceiling; the cron val and ?build_status both ask for 40s.
 *
 *  This exists to separate two things the budget guard used to conflate. "This step does not fit THIS
 *  tick" is a property of the CALLER - ?build_start runs tick(6_000) precisely so it can return fast -
 *  and it was answered with fail(), which is terminal and cascades: one 6s tick failed the first ready
 *  step and blocked every step downstream of it, so the route whose whole purpose is to START a build
 *  destroyed the build at creation (measured: 1 failed, 4 blocked, nothing left runnable). "This step
 *  cannot fit ANY tick" is a property of the STEP, is permanent, and must still fail loudly - a step
 *  nobody can ever run would otherwise sit ready forever. */
export const MAX_TICK_BUDGET_MS = T.maxTick;

/** Exported so the equivalence test runs the SHIPPED statement rather than a copy that can drift from it. */
// The claim predicate must admit exactly what READY_SQL surfaces, including a step whose holder was
// killed mid-flight (status still 'running', lease lapsed). An earlier version required status='ready'
// here while READY_SQL also returned expired-lease rows: those rows were then listed as runnable on
// every tick forever and could never be claimed by anyone — a permanently stuck queue entry that looks
// like work in progress. Reclaiming an orphan is the same statement as claiming a fresh step.
export const CLAIM_SQL =
  `UPDATE step SET status='running', attempts=attempts+1, lease_until=:lease, updated=:now, started=:now
   WHERE id=:id AND run_after<=:now
     AND (status='ready' OR (status='running' AND lease_until<=:now))
     AND (needs IS NULL OR (SELECT status FROM step p WHERE p.id=step.needs)='done')
     AND (step.gate IS NULL OR NOT EXISTS (
       SELECT 1 FROM step g WHERE g.job = step.job AND g.kind = step.gate
         AND g.status NOT IN ('done','failed','blocked','skipped')))`;

export const READY_SQL =
  `SELECT * FROM step WHERE status IN ('ready','running') AND run_after<=:now
     AND (status='ready' OR lease_until<=:now)
     AND (needs IS NULL OR (SELECT status FROM step p WHERE p.id=step.needs)='done')
     AND (step.gate IS NULL OR NOT EXISTS (
       SELECT 1 FROM step g WHERE g.job = step.job AND g.kind = step.gate
         AND g.status NOT IN ('done','failed','blocked','skipped')))
   ORDER BY priority DESC, seq ASC, id ASC LIMIT :lim`;

/** Bind :named placeholders positionally, deriving the argument list from the statement itself.
 *
 *  These two statements are written as text (not via the `sql` tagged template) because they are
 *  exported for the equivalence test to execute. Hand-maintaining a parallel positional args array
 *  against them is a live trap: editing the SQL silently changes the placeholder count, and both bugs
 *  this module shipped with were exactly that — one arg too many in the ready query, then one too few in
 *  the claim after a predicate gained a third `:now`. Deriving the args from the text makes the class of
 *  mistake unrepresentable rather than merely fixed. A missing key throws rather than binding NULL,
 *  because a silently-NULL comparison in a claim predicate fails closed and looks like contention. */
/** Returns db.ts's `Bound` shape - { text, values } - and NOT { text, args }.
 *
 *  It returned `args` for its entire life. db.ts does `sqlite.execute({ sql: q.text, args: q.values })`,
 *  so every scheduler query went out with args: undefined and failed. The scheduler never ran one step.
 *  Both call sites cast `as any`, which is precisely what stopped the compiler from saying so; the casts
 *  are gone now, so this can never drift again without a type error. */
export function bind(text: string, params: Record<string, string | number | null>): Bound {
  const values: (string | number | null)[] = [];
  const out = text.replace(/:(\w+)/g, (_m, k: string) => {
    if (!(k in params)) throw new Error(`scheduler.bind: unbound placeholder :${k}`);
    values.push(params[k]);
    return "?";
  });
  return { text: out, values };
}

export type StepRow = {
  id: number; job: string; seq: number; kind: string; payload: string; status: string;
  attempts: number; run_after: number; lease_until: number; needs: number | null; gate: string | null; priority: number; started?: number;
  result: string | null; error: string | null; created: number; updated: number;
};
export type Handler = { maxMs: number; run: (payload: any, ctx: { step: StepRow; deadline: number }) => Promise<unknown> };

const handlers = new Map<string, Handler>();
export const registerHandler = (kind: string, h: Handler) => handlers.set(kind, h);
export const knownKinds = () => [...handlers.keys()];

/** [12] Exponential backoff with FULL JITTER.
 *
 *  A previous version was deterministic, with a comment claiming steps are "already spread across
 *  ticks". They are not: the steps that matter here failed together, because they failed for the same
 *  reason — one provider outage, one bad deploy. Deterministic backoff maps a synchronised failure to a
 *  synchronised retry and preserves the correlation forever. Simulated with 64 steps failing at the same
 *  instant: deterministic put all 64 retries in a single one-second bucket on every round (4 distinct
 *  buckets total); full jitter peaked at 17 and spread across 112. The herd is the thing that re-breaks
 *  a provider that was just coming back.
 *
 *  Full jitter (sleep ~ U(0, base)) rather than equal jitter (base/2 + U(0, base/2)): it spreads
 *  strictly better (peak 17 vs 24 here) and the halved expected delay is not a cost worth protecting
 *  when the alternative is re-synchronising the herd. */
export const backoffBaseMs = (attempts: number) => Math.min(15 * 60_000, 5_000 * Math.pow(4, attempts - 1));
export const backoffMs = (attempts: number, rnd: () => number = Math.random) =>
  Math.max(1_000, Math.floor(backoffBaseMs(attempts) * rnd()));

export type NewStep = { kind: string; payload?: unknown; seq?: number; priority?: number; needs?: number | null; runAfter?: number; dedupe?: string; gate?: string };

/** [14] Stability bound. Derived, not chosen: at a 40s tick with 25s steps the sequential drain rate is
 *  1 step/tick, so a minute-cadence cron sustains ~1 step/min. A backlog above this cannot be worked off
 *  by waiting. Concurrency (see TICK_CONCURRENCY) raises the service rate; this cap tracks it. */
export const MAX_QUEUE_DEPTH = 500;
export async function queueDepth(): Promise<number> {
  const r = await one("step", sql`SELECT COUNT(*) AS n FROM step WHERE status IN ('ready','running')`);
  return r.ok && r.value ? Number((r.value as any).n) : 0;
}

/** Enqueue a decomposed job. Steps run in `seq` order when chained via `needs`; independent steps
 *  (no `needs`) are free to run in any order and across different ticks. */
export async function enqueue(job: string, steps: NewStep[]): Promise<number[]> {
  const now = Date.now();
  const ids: number[] = [];
  let prev: number | null = null;
  // [14] ADMISSION CONTROL (Little's law). In steady state L = lambda * W; the queue is stable only
  // while arrivals stay below the drain rate. Service rate here is (steps per tick) / (tick period) and
  // is bounded and knowable, so an unbounded backlog is not a capacity problem to be scaled away, it is
  // a stability violation to be refused at the door. Refusing early is visible; silently accumulating a
  // queue that can never drain is not.
  if (await queueDepth() >= MAX_QUEUE_DEPTH) throw new Error(`scheduler: queue depth >= ${MAX_QUEUE_DEPTH}; refusing to enqueue "${job}" (drain first)`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const needs = s.needs === undefined ? null : s.needs;
    // GATE INVARIANT. A gate is satisfied when NO step of that kind is unfinished — and an empty set is
    // no steps, so a gated step enqueued before its gated set exists runs IMMEDIATELY. That is the one
    // way to misuse this primitive, and it is silent: the integrate step simply fires before any builder
    // has been created. The set is created by some earlier step (the planner), so requiring `needs` to
    // point at that step makes the hazard unrepresentable rather than documented.
    if (s.gate && needs === null && s.needs !== -1) {
      throw new Error(`scheduler: step "${s.kind}" has gate="${s.gate}" but no needs — it would run before any ${s.gate} step exists; gate it on the step that creates them`);
    }
    // [15] IDEMPOTENCY. The supervisor re-observes the same job every pass and would otherwise
    // re-enqueue an identical repair each time it still sees the symptom it is trying to fix — the
    // failure feeding the response that is supposed to cure it. A dedupe key makes re-enqueue a no-op.
    if (s.dedupe) {
      const dup = await one("step", sql`SELECT id FROM step WHERE job = ${job} AND kind = ${s.kind} AND payload LIKE ${'%"__dedupe":"' + s.dedupe + '"%'} LIMIT 1`);
      if (dup.ok && dup.value) { ids.push(Number((dup.value as any).id)); continue; }
    }
    const payloadObj = s.dedupe ? { ...(s.payload as object ?? {}), __dedupe: s.dedupe } : (s.payload ?? {});
    const w = await run(sql`INSERT INTO step (job, seq, kind, payload, status, attempts, run_after, lease_until, needs, gate, priority, created, updated)
      VALUES (${job}, ${s.seq ?? i}, ${s.kind}, ${JSON.stringify(payloadObj)}, 'ready', 0, ${s.runAfter ?? now}, 0,
              ${needs === -1 ? prev : needs}, ${s.gate ?? null}, ${s.priority ?? 0}, ${now}, ${now})`);
    if (!w.ok || w.value.lastInsertRowid === undefined) continue;
    prev = Number(w.value.lastInsertRowid);
    ids.push(prev);
  }
  const cyc = await detectCycle(job);
  if (cyc) throw new Error(`scheduler: dependency cycle in job "${job}" (${cyc.join(" -> ")}); every step in it would wait forever`);
  return ids;
}

/** Convenience: a strictly sequential chain, each step gated on the previous one. */
export const enqueueChain = (job: string, steps: NewStep[]) =>
  enqueue(job, steps.map((s, i) => (i === 0 ? s : { ...s, needs: -1 })));

export type TickReport = {
  /** Set when the queue could not be READ. Absent on a healthy tick, idle or busy. */
  error?: string; ran: number; done: number; failed: number; retried: number; skipped: number; ms: number; budgetLeft: number };

/** [13] Drain ready steps, up to TICK_CONCURRENCY at a time.
 *
 *  Throughput analysis, not preference. A tick is a wall-clock window, and a step is almost entirely
 *  network wait, so serialising steps wastes the window: with a 40s tick and 25s build steps the
 *  sequential drain rate is exactly 1 step/tick, i.e. ~1 step/min on a minute cadence, i.e. **16 minutes
 *  for a 16-file build**. The same tick at concurrency 8 fits 8 steps, giving ~2 minutes. That is the
 *  difference between a scheduler that can replace the existing parallel fanout and one that is a 10x
 *  regression against it.
 *
 *  Concurrency is bounded, not unbounded: each in-flight step holds a provider slot and a lease, and the
 *  reason the old fanout staggered its starts is that N simultaneous launches trip edge and per-second
 *  vendor limits. Claims remain individually atomic, so two drivers at concurrency 8 still cannot double
 *  -run a step — that property comes from the claim predicate, not from serialisation.
 *
 *  A step is never STARTED unless its full maxMs fits in the remaining window: a step killed mid-flight
 *  is retried for no reason, which converts a budget overrun into a retry loop. */
/** Steps executed in parallel per tick.
 *
 *  Measured on a 13-file build (one model call per file): conc 2 → 24.1s, 4 → 15.1s, 6 → 12.0s,
 *  12 → 9.0s, 24 → 6.0s. Build steps are network-bound, not CPU-bound, so the curve keeps improving;
 *  6 was leaving half the wall clock unused and forcing a second poll for a job that fits in one.
 *
 *  The real ceiling is NOT this scheduler - it is provider rate limits. Too many simultaneous calls to
 *  one vendor earns 429s, which cost more than the parallelism saves. 12 is the default because it
 *  halves the polls for a typical build while staying under a single vendor's burst allowance; raise it
 *  with OMNI_TICK_CONCURRENCY when the roster is wide enough to absorb it. */
export const TICK_CONCURRENCY = (() => {
  const n = Number((globalThis as any)?.Deno?.env?.get?.("OMNI_TICK_CONCURRENCY"));
  return Number.isFinite(n) && n >= 1 && n <= 64 ? Math.floor(n) : 12;
})();

export async function tick(budgetMs: number, opts: { max?: number; concurrency?: number } = {}): Promise<TickReport> {
  const started = Date.now();
  const deadline = started + budgetMs;
  // `??` only falls back on null/undefined, so an explicit 0 - from a caller, or from a mis-set env var
  // parsed to 0 - became Math.max(1, 0) = 1 and the scheduler ran serially with nothing reporting why.
  // A 13-file build took 42s instead of 9s. `|| TICK_CONCURRENCY` treats 0 as "unset", which it is.
  const conc = Math.max(1, Math.min(64, Number(opts.concurrency) || TICK_CONCURRENCY));
  const rep: TickReport = { ran: 0, done: 0, failed: 0, retried: 0, skipped: 0, ms: 0, budgetLeft: 0 };
  const remaining = () => deadline - Date.now();
  let ranTotal = 0;
  const cap = opts.max ?? Math.max(50, conc * 8); // scales with concurrency; a fixed 50 throttled a wide tick

  while (remaining() > FLUSH_RESERVE_MS && ranTotal < cap) {
    const nowTs = Date.now();
    const r = await all("step", bind(READY_SQL, { now: nowTs, lim: 4 * conc }));
    if (!r.ok) {
      // A failed query is NOT an empty queue. Conflating them is how this scheduler sat dead for its whole
      // life reporting ran:0 - the single most misleading value it could have returned, because it is also
      // exactly what a healthy idle queue reports.
      rep.error = `step query failed: ${String((r as any).error).slice(0, 200)}`;
      break;
    }
    const rows = r.value as unknown as StepRow[];
    if (!rows.length) break;

    // Claim a wave. Claiming is sequential (each claim is one cheap conditional UPDATE); only the
    // handlers run concurrently, which is where the wall-clock actually goes.
    const wave: StepRow[] = [];
    const ranked = rows.slice().sort((a, b) => effectivePriority(b, nowTs) - effectivePriority(a, nowTs) || a.seq - b.seq || a.id - b.id);
    for (const row of ranked) {
      if (wave.length >= conc || ranTotal + wave.length >= cap) break;
      const h = handlers.get(row.kind);
      if (!h) { await fail(row, `no handler registered for kind "${row.kind}"`); continue; }
      // Permanent: no caller could ever run this step. Terminal failure is correct.
      if (h.maxMs + FLUSH_RESERVE_MS > MAX_TICK_BUDGET_MS) { await fail(row, `step kind "${row.kind}" declares maxMs=${h.maxMs}, which cannot fit even the largest tick (${MAX_TICK_BUDGET_MS}ms, reserve ${FLUSH_RESERVE_MS}ms) — split it into smaller steps`); continue; }
      // Transient: THIS tick is too short. Leave the step ready for a longer one; failing it here killed
      // whole jobs (see MAX_TICK_BUDGET_MS above).
      if (h.maxMs + FLUSH_RESERVE_MS > budgetMs) { rep.skipped++; continue; }
      if (h.maxMs + FLUSH_RESERVE_MS > remaining()) { rep.skipped++; continue; }
      const now = Date.now();
      const w = await run(bind(CLAIM_SQL, { lease: now + h.maxMs + LEASE_GRACE_MS, now, id: row.id }));
      if (w.ok && w.value.rowsAffected === 1) wave.push(row);
    }
    if (!wave.length) break; // nothing ready fits this tick, or a sibling driver took it all

    ranTotal += wave.length;
    rep.ran += wave.length;
    await Promise.all(wave.map(async (step) => {
      const h = handlers.get(step.kind)!;
      try {
        const out = await h.run(JSON.parse(step.payload || "{}"), { step, deadline: Math.min(deadline, Date.now() + h.maxMs) });
        await run(sql`UPDATE step SET status='done', result=${JSON.stringify(out ?? null).slice(0, 4000)}, error=NULL, lease_until=0, updated=${Date.now()} WHERE id=${step.id}`);
        rep.done++;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 500);
        (await retryOrFail(step, msg)) ? rep.retried++ : rep.failed++;
      }
    }));
  }
  rep.ms = Date.now() - started;
  rep.budgetLeft = Math.max(0, remaining());
  return rep;
}

async function retryOrFail(row: StepRow, msg: string): Promise<boolean> {
  if (row.attempts >= MAX_ATTEMPTS) { await fail(row, msg); return false; }
  await run(sql`UPDATE step SET status='ready', run_after=${Date.now() + backoffMs(row.attempts)}, lease_until=0, error=${msg}, updated=${Date.now()} WHERE id=${row.id}`);
  return true;
}
/** Terminal failure, plus the cascade.
 *
 *  `needs` gates on the predecessor being 'done', so a FAILED predecessor leaves every dependent sitting
 *  in 'ready' forever — visible in the queue, never runnable, and counted as pending by jobStatus(). A
 *  caller polling for completion would wait indefinitely on a job that can never progress. Failure has to
 *  propagate, transitively, or the DAG has no terminal state. `blocked` is distinct from `failed` so the
 *  UI can say "this did not run because something upstream failed" rather than implying N independent
 *  failures; a retry of the root can reset the whole subtree. */
async function fail(row: StepRow, msg: string): Promise<void> {
  await run(sql`UPDATE step SET status='failed', error=${msg}, lease_until=0, updated=${Date.now()} WHERE id=${row.id}`);
  await cascadeBlock(row.id, row.job);
}

export async function cascadeBlock(rootId: number, job: string): Promise<number> {
  let frontier = [rootId], blocked = 0;
  // Depth-bounded: `needs` is a self-reference and nothing structurally forbids a cycle, so an
  // unbounded walk could spin inside the tick budget it is supposed to protect.
  for (let depth = 0; depth < 25 && frontier.length; depth++) {
    // ONE query per LEVEL, not one per node, and one UPDATE per level rather than one per row. A wide
    // fan-out is the normal shape here — a failed plan step blocks every file it planned — so the old
    // loop cost 2N round trips against a network database at exactly the moment the tick budget is
    // already spent. `frontier` holds integers this function put there itself, so the IN list is built
    // from numbers, never from anything a caller supplied.
    const ids = frontier.map((n) => Number(n)).filter(Number.isInteger);
    if (!ids.length) break;
    const q = await all("step", sql`SELECT id FROM step WHERE job = ${job} AND status IN ('ready','running') AND needs IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
    const found = ((q.ok ? q.value : []) as any[]).map((row) => Number(row.id)).filter(Number.isInteger);
    if (!found.length) break;
    await run(sql`UPDATE step SET status='blocked', error='upstream step failed', lease_until=0, updated=${Date.now()} WHERE id IN (SELECT value FROM json_each(${JSON.stringify(found)}))`);
    blocked += found.length;
    frontier = found;
  }
  return blocked;
}

/** [16] CYCLE DETECTION. `needs` is a self-reference, so nothing structurally prevents a -> b -> a.
 *  A cycle is not a crash; it is worse — every member is permanently un-runnable because each waits on a
 *  predecessor that is waiting on it, so the job reports pending forever and looks merely slow. Floyd is
 *  unnecessary here: the graph is tiny and each node has out-degree <= 1, so a bounded walk from each
 *  unfinished node either terminates or revisits, and revisiting IS the cycle. Run at enqueue time. */
export async function detectCycle(job: string): Promise<number[] | null> {
  const r = await all("step", sql`SELECT id, needs FROM step WHERE job = ${job}`);
  const needs = new Map<number, number | null>();
  for (const row of (r.ok ? r.value : []) as any[]) needs.set(Number(row.id), row.needs === null ? null : Number(row.needs));
  // LINEAR, not quadratic. This used to walk the parent chain from EVERY node with a fresh `seen` set,
  // so a straight dependency chain of N steps re-walked the same tail N times: O(N^2) pointer-follows
  // on a structure a wide build makes hundreds of nodes long, inside enqueue, which the plan step calls
  // once per file. `needs` is a single-parent pointer, so a node already proven acyclic can never
  // become cyclic — remembering that across starts makes every edge visited exactly once.
  const safe = new Set<number>();
  for (const start of needs.keys()) {
    if (safe.has(start)) continue;
    const path: number[] = [];
    const onPath = new Set<number>();
    let cur: number | null = start;
    while (cur !== null && needs.has(cur) && !safe.has(cur)) {
      if (onPath.has(cur)) return [...path.slice(path.indexOf(cur)), cur];
      onPath.add(cur);
      path.push(cur);
      cur = needs.get(cur) ?? null;
    }
    for (const n of path) safe.add(n);
  }
  return null;
}

/** [17] PRIORITY AGING. Ordering by (priority, seq) alone lets a steady arrival of high-priority work
 *  starve a low-priority step indefinitely — the classic static-priority failure. Effective priority
 *  grows with wait time, so every step is eventually scheduled: a bounded-wait guarantee rather than a
 *  hope. One point per AGING_STEP_MS waited; a step waiting an hour outranks a fresh priority-10 repair. */
export const AGING_STEP_MS = 6 * 60_000;
export const effectivePriority = (row: { priority: number; created: number }, now = Date.now()) =>
  row.priority + Math.floor(Math.max(0, now - row.created) / AGING_STEP_MS);

/** A job is finished when nothing is left ready or running. Used by callers that need to know whether to
 *  keep ticking, and by the UI to show progress without inventing its own bookkeeping. */
export async function jobStatus(job: string) {
  const r = await all("step", sql`SELECT status, COUNT(*) AS n FROM step WHERE job = ${job} GROUP BY status`);
  const by: Record<string, number> = {};
  for (const row of (r.ok ? r.value : []) as any[]) by[row.status] = Number(row.n);
  const pending = (by.ready ?? 0) + (by.running ?? 0);
  return { by, pending, done: pending === 0, total: Object.values(by).reduce((a, b) => a + b, 0) };
}

export const nextRunAt = async (): Promise<number | null> => {
  const r = await one("step", sql`SELECT MIN(run_after) AS t FROM step WHERE status='ready'`);
  const t = r.ok && r.value ? Number((r.value as any).t) : NaN;
  return Number.isFinite(t) ? t : null;
};
