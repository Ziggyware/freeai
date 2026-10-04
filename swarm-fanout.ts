import { T, stepMs } from "./timing.ts";
import { tick, type TickReport } from "./scheduler.ts";

/* TRUE PARALLELISM INSIDE ONE VAL.
 *
 *  The platform kills an invocation at ~60s. Everything this system does is therefore bounded by ONE
 *  invocation's clock — and `tick()` running a wave of steps concurrently does not change that: those
 *  steps share a single isolate, a single 60s budget, and a single CPU. Twelve 18s build steps inside
 *  one poll is 18s of wall clock only if nothing blocks; in practice it is the poll's whole budget, and
 *  the queue drains one pollful at a time no matter how wide the wave.
 *
 *  What DOES change it, without adding a single new val: an invocation can call its own HTTP endpoint.
 *  Each inbound request is a separate invocation with its own fresh 60s budget, its own isolate, and its
 *  own CPU slice. So the poll stops being the worker and becomes the dispatcher — it fires N concurrent
 *  requests at `?drain`, each of which claims and runs ONE step and returns. N steps genuinely run at
 *  the same time, on N clocks, in the same val.
 *
 *  This is safe because claiming is already an atomic conditional UPDATE (scheduler.ts CLAIM_SQL): two
 *  drains racing for the same step means exactly one gets rowsAffected === 1 and the other moves on.
 *  That property was built for overlapping polls; fan-out is the same race, deliberately.
 *
 *  The ceiling is not this code. It is provider rate limits — N simultaneous model calls to one vendor
 *  earns 429s that cost more than the parallelism saves. FANOUT_WIDTH is set against that, not against
 *  what the platform would allow. */
export const FANOUT_WIDTH = (() => {
  const n = Number((globalThis as any)?.Deno?.env?.get?.("OMNI_FANOUT_WIDTH"));
  return Number.isFinite(n) && n >= 1 && n <= 16 ? Math.floor(n) : 6;
})();

/** One drain's clock: the largest step it might claim, room to record the result, and a MARGIN.
 *
 *  The margin is not padding. The first version of this was exactly stepMs("build") + flushReserve, and
 *  the first live call returned `{"ran":0,"skipped":4,"budgetLeft":20981}` — four build steps refused by
 *  a drain sized precisely to hold one. The scheduler admits a step only while
 *  `h.maxMs + FLUSH_RESERVE_MS <= remaining()`, and `remaining()` is measured AFTER the claim query has
 *  already spent a few milliseconds. A budget equal to the requirement is therefore always a few
 *  milliseconds short by the time it is tested, so the largest step in the system could never be claimed
 *  by a drain — every build would be skipped, forever, while the queue reported itself perfectly healthy.
 *  Caught by running the route rather than by reading it. */
export const DRAIN_BUDGET_MS = Math.min(T.inRequestTick, stepMs("build") + T.flushReserve + T.transportMargin);

export type FanReport = { width: number; ran: number; done: number; failed: number; retried: number; skipped: number; errors: string[]; ms: number; mode: "fanout" | "inline" };

/** A drain never fans out. Without this the first poll spawns N, each of which spawns N, and the val
 *  DDoSes itself geometrically — the single most expensive bug this pattern can have. The header is set
 *  by fanOut() below and checked by the route. */
export const DRAIN_HEADER = "x-omni-drain";

/** Run ONE step's worth of queue, in this invocation. This is the whole body of the `?drain` route. */
export async function drainOne(): Promise<TickReport> {
  return await tick(DRAIN_BUDGET_MS, { max: 1, concurrency: 1 });
}

/** Dispatch `width` concurrent drains against this val's own origin, then report what they did.
 *
 *  `origin` comes from the live request, never from configuration: a val is reachable under several
 *  hostnames (the val.run subdomain, a custom domain, a branch preview) and hardcoding one of them
 *  sends the fan-out to a DIFFERENT deployment than the one serving the request — which would silently
 *  run the user's steps against stale code. */
export async function fanOut(origin: string, width = FANOUT_WIDTH, deadlineMs = T.pollTick): Promise<FanReport> {
  const t0 = Date.now();
  const agg: FanReport = { width, ran: 0, done: 0, failed: 0, retried: 0, skipped: 0, errors: [], ms: 0, mode: "fanout" };

  // One controller for the whole wave: when the dispatcher's own clock runs out, every outstanding drain
  // is abandoned AT ONCE. The steps they were running are not lost — their leases lapse and the next
  // poll re-claims them — but the dispatcher must answer its caller on time regardless.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1_000, deadlineMs));
  try {
    const calls = Array.from({ length: width }, async (_, i) => {
      try {
        const res = await fetch(`${origin}/?drain`, {
          method: "POST",
          headers: { [DRAIN_HEADER]: "1", "content-type": "application/json" },
          body: "{}",
          signal: ctl.signal,
        });
        if (!res.ok) return { error: `drain#${i} HTTP ${res.status}` };
        return await res.json();
      } catch (e) {
        // An aborted drain is the dispatcher running out of time, not a failure of the work.
        const msg = String((e as Error)?.message ?? e);
        return { error: /abort/i.test(msg) ? `drain#${i} abandoned at deadline` : `drain#${i} ${msg.slice(0, 120)}` };
      }
    });
    for (const r of await Promise.all(calls)) {
      const x = r as Record<string, unknown>;
      if (typeof x?.error === "string") { agg.errors.push(x.error); continue; }
      agg.ran += Number(x?.ran ?? 0);
      agg.done += Number(x?.done ?? 0);
      agg.failed += Number(x?.failed ?? 0);
      agg.retried += Number(x?.retried ?? 0);
      agg.skipped += Number(x?.skipped ?? 0);
      if (typeof x?.error === "string") agg.errors.push(String(x.error));
    }
  } finally {
    clearTimeout(timer);
  }
  agg.ms = Date.now() - t0;
  return agg;
}

/** What `?build_status` calls. Fan-out when the origin is known and this request is not itself a drain;
 *  otherwise the old in-process tick, unchanged. Fail-open by construction: if every fanned request
 *  errors — the val cannot reach itself, an egress rule blocks it, a deploy is mid-flight — the queue
 *  still drains here, just serially, and the report says which path ran. */
export async function driveQueue(req: Request, origin: string, budgetMs = T.pollTick): Promise<FanReport> {
  if (req.headers.get(DRAIN_HEADER)) {
    const r = await tick(budgetMs).catch((e) => ({ ran: 0, done: 0, failed: 0, retried: 0, skipped: 0, ms: 0, error: String(e?.message ?? e) } as TickReport));
    return { width: 1, ran: r.ran, done: r.done, failed: r.failed, retried: r.retried, skipped: r.skipped, errors: r.error ? [r.error] : [], ms: r.ms, mode: "inline" };
  }
  const fan = await fanOut(origin, FANOUT_WIDTH, budgetMs);
  if (fan.ran > 0 || fan.errors.length < fan.width) return fan;
  // Every drain failed. Do the work here rather than reporting an idle queue that is in fact stuck.
  const r = await tick(budgetMs).catch((e) => ({ ran: 0, done: 0, failed: 0, retried: 0, skipped: 0, ms: 0, error: String(e?.message ?? e) } as TickReport));
  return { width: 1, ran: r.ran, done: r.done, failed: r.failed, retried: r.retried, skipped: r.skipped, errors: [...fan.errors, ...(r.error ? [r.error] : [])], ms: r.ms, mode: "inline" };
}
