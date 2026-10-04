// Bounded telemetry. The event log answers "what happened on request X" and must be retained; the
// health view answers "what is provider P doing lately" and must NOT require retaining every row to
// compute. Those are different questions with different space requirements, and conflating them is how
// observability turns into a storage problem.
//
// [8] O(K) NOT O(K*T). Per-provider summaries are maintained as fixed-size sketches updated in place:
//     space is linear in the number of providers and independent of traffic and of the retention window.
//     This is the streaming-algorithms discipline — one pass, sublinear space, provable error — applied
//     to the one place here that actually needs it.

export type Sketch = {
  ewOk: number; ewLat: number; ewVar: number; n: number;
  hist: number[];        // [10] log2 latency buckets
  errs: string[];        // [9] reservoir sample of error exemplars
  errSeen: number;
  lastTs: number;
};
export const HIST_BUCKETS = 16;          // 2^0 .. 2^15 ms -> 1ms .. ~33s, which covers the 30s ceiling
export const RESERVOIR = 8;
export const newSketch = (): Sketch =>
  ({ ewOk: 0.5, ewLat: 3000, ewVar: 1e6, n: 0, hist: new Array(HIST_BUCKETS).fill(0), errs: [], errSeen: 0, lastTs: 0 });

const bucketOf = (ms: number) => Math.max(0, Math.min(HIST_BUCKETS - 1, Math.floor(Math.log2(Math.max(1, ms)))));

/** [9] RESERVOIR SAMPLING (Vitter R). Keeps a uniform sample of size k from an unbounded stream in one
 *  pass and O(k) space: the i-th item is kept with probability k/i, replacing a uniformly chosen
 *  incumbent. Keeping "the last 8 errors" instead would oversample whatever happened most recently —
 *  precisely the wrong bias when the question is which failures are typical rather than which are newest. */
export function reservoirAdd(s: Sketch, item: string, rnd: () => number = Math.random): void {
  s.errSeen++;
  if (s.errs.length < RESERVOIR) { s.errs.push(item); return; }
  const j = Math.floor(rnd() * s.errSeen);
  if (j < RESERVOIR) s.errs[j] = item;
}

/** [10] LOG-BUCKET HISTOGRAM. Exact quantiles need the whole sample; log2 buckets bound relative error
 *  at a factor of 2 per bucket in O(1) space, which is the right resolution for a timeout decision —
 *  the difference between 2s and 3s does not change routing, the difference between 2s and 20s does. */
export function observeSketch(s: Sketch, ok: boolean, latMs: number, now: number, a = 0.2, err?: string, rnd?: () => number): void {
  const d = latMs - s.ewLat;
  s.ewOk = (1 - a) * s.ewOk + a * (ok ? 1 : 0);
  s.ewLat = s.ewLat + a * d;
  s.ewVar = (1 - a) * (s.ewVar + a * d * d);
  s.n++; s.lastTs = now;
  s.hist[bucketOf(latMs)]++;
  if (!ok && err) reservoirAdd(s, err.slice(0, 160), rnd);
}

/** Quantile from the log histogram. Returns the bucket's upper bound: an over-estimate by design, since
 *  a timeout derived from it should err toward patience rather than toward cutting off live work. */
export function quantile(s: Sketch, q: number): number {
  const total = s.hist.reduce((a, b) => a + b, 0);
  if (!total) return s.ewLat;
  let seen = 0;
  for (let i = 0; i < s.hist.length; i++) { seen += s.hist[i]; if (seen >= q * total) return Math.pow(2, i + 1); }
  return Math.pow(2, HIST_BUCKETS);
}

/** [11] HASH TRUNCATION AND THE BIRTHDAY BOUND. Content addressing collides at ~2^(b/2) distinct items
 *  for a b-bit digest. 64 bits collides at ~4e9 — reachable by a machine writing versions in a loop, and
 *  a collision here silently serves the WRONG file content. 128 bits collides at ~1.8e19, which is not.
 *  Truncate to 32 hex chars, never fewer. */
export const HASH_HEX_CHARS = 32; // 128 bits
export const truncateHash = (hex: string) => hex.slice(0, HASH_HEX_CHARS);
export const birthdayCollisionAt = (bits: number) => Math.pow(2, bits / 2);

/** Serialised form is bounded and fixed-width, so a row cannot grow with traffic. */
export const packSketch = (s: Sketch) => JSON.stringify({
  o: Number(s.ewOk.toFixed(4)), l: Math.round(s.ewLat), v: Math.round(s.ewVar),
  n: s.n, h: s.hist, e: s.errs, es: s.errSeen, t: s.lastTs,
});
export function unpackSketch(raw: string): Sketch {
  try {
    const j = JSON.parse(raw);
    return { ewOk: j.o ?? 0.5, ewLat: j.l ?? 3000, ewVar: j.v ?? 1e6, n: j.n ?? 0,
      hist: Array.isArray(j.h) && j.h.length === HIST_BUCKETS ? j.h : new Array(HIST_BUCKETS).fill(0),
      errs: Array.isArray(j.e) ? j.e.slice(0, RESERVOIR) : [], errSeen: j.es ?? 0, lastTs: j.t ?? 0 };
  } catch { return newSketch(); }
}
