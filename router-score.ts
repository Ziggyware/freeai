// Estimation and ordering for the router. Every constant here is derived, not tuned by hand; the
// derivation is stated next to it so it can be checked rather than trusted.
//
// [1] ORDERING. Sequential trials, trial i costs t_i and succeeds w.p. p_i. Minimise E[time to first
//     success]. For adjacent i,j the exchange difference is
//        E - E' = p_j t_i - p_i t_j,
//     so i precedes j iff p_i/t_i > p_j/t_j. The optimal static order is by DECREASING p/t. An earlier
//     version scored p/sqrt(t), which has no such argument behind it and is measurably worse.

export type Est = {
  eOk: number;    // EWMA success rate
  eLat: number;   // EWMA latency, ms
  eVar: number;   // EWMA of squared deviation -> variance, for the tail bound in [4]
  n: number;      // raw observation count, for the confidence gate in [3]
  lastTs: number;
  llr: number;    // sequential log-likelihood ratio for [5]
};
export const newEst = (): Est => ({ eOk: 0.5, eLat: 3000, eVar: 1e6, n: 0, lastTs: 0, llr: 0 });

// [2] EWMA effective sample size. For weight a, ESS = (2-a)/a. a=0.2 -> ESS 9, i.e. the estimate is
//     worth about nine observations. This is what makes forgetting tunable rather than arbitrary: a
//     provider that recovers needs ~ESS observations to climb back, so ESS sets the recovery latency.
export const ALPHA = 0.2;
export const ess = (a = ALPHA) => (2 - a) / a;

// [3] Unknown must not read as bad. A provider with no history gets the prior (0.5), and its score is
//     only trusted once it has enough observations; below that it is ordered by the prior so it is
//     explored rather than buried. Hoeffding: to place p within +-eps w.p. 1-delta needs
//        n >= ln(2/delta) / (2 eps^2).
//     eps=0.2, delta=0.05 -> n >= 47. That is the honest number for "we know this provider's rate",
//     and it is far more than a couple of probes, which is why demotion below uses a sequential test
//     rather than waiting for it.
export const hoeffdingN = (eps: number, delta = 0.05) => Math.ceil(Math.log(2 / delta) / (2 * eps * eps));
export const CONFIDENT_N = 8; // enough to move off the prior; full Hoeffding confidence is 47 and is not required to ORDER

export function observe(e: Est, ok: boolean, latMs: number, now: number, a = ALPHA): Est {
  const d = latMs - e.eLat;
  return {
    eOk: (1 - a) * e.eOk + a * (ok ? 1 : 0),
    eLat: e.eLat + a * d,
    eVar: (1 - a) * (e.eVar + a * d * d), // West's incremental EWMA variance
    n: e.n + 1,
    lastTs: now,
    llr: e.llr,
  };
}

// [1] applied. Guard the divisor: a provider that fails in 200ms would otherwise score enormously on
// p/t if p is even slightly above zero, and fast-failing is exactly what a dead endpoint does.
export const MIN_T = 500;
export function score(e: Est): number {
  const p = e.n >= CONFIDENT_N ? e.eOk : 0.5 * (1 - e.n / CONFIDENT_N) + e.eOk * (e.n / CONFIDENT_N);
  return p / Math.max(MIN_T, e.eLat);
}
export const orderByScore = <T>(xs: T[], est: (x: T) => Est): T[] =>
  xs.map((x) => ({ x, s: score(est(x)) })).sort((u, v) => v.s - u.s).map((u) => u.x);

// [4] ADAPTIVE PER-ATTEMPT TIMEOUT. A fixed 30s ceiling spends the same on a provider whose latency is
//     tightly concentrated at 2s as on one that is genuinely slow. One-sided Chebyshev (Cantelli) gives,
//     for any distribution with mean mu and variance s^2,
//        P(X - mu >= k s) <= 1/(1+k^2),
//     so cutting at mu + k*s wrongly aborts at most 1/(1+k^2) of genuine successes. k=4 -> <=5.9%.
//     Distribution-free, which matters because provider latency is not Gaussian and is often bimodal
//     (fast path vs. queued). Clamped to the global ceiling and floored so a fast provider still gets a
//     usable window.
export const CHEBY_K = 4;
export function adaptiveTimeoutMs(e: Est, hardCeilMs: number, floorMs = 4000): number {
  if (e.n < CONFIDENT_N) return hardCeilMs; // not enough evidence to tighten; never widen past the ceiling
  const sd = Math.sqrt(Math.max(0, e.eVar));
  return Math.max(floorMs, Math.min(hardCeilMs, Math.round(e.eLat + CHEBY_K * sd)));
}
export const chebyshevMissRate = (k = CHEBY_K) => 1 / (1 + k * k);

// [5] SEQUENTIAL TEST FOR "CONFIG-DEAD" (Wald's SPRT). The shipped rule is two consecutive config-class
//     failures. That is a fixed-sample test with an error rate nobody chose: for a healthy provider with
//     per-call config-error probability q, the false-demotion rate is q^2 per pair.
//     SPRT instead accumulates evidence and stops when it is conclusive, with SPECIFIED error rates:
//        H0: p_fail = p0 (healthy)   H1: p_fail = p1 (dead)
//        llr += ln( P(x|H1) / P(x|H0) );  demote when llr >= ln((1-beta)/alpha).
//     It reaches the same conclusion faster on clear evidence and refuses to conclude on weak evidence,
//     which is the behaviour the fixed rule cannot express. Wald: E[n] is minimal among tests with the
//     same alpha, beta.
export const SPRT = { p0: 0.05, p1: 0.75, alpha: 0.02, beta: 0.05 };
export const sprtUpper = () => Math.log((1 - SPRT.beta) / SPRT.alpha);
export const sprtLower = () => Math.log(SPRT.beta / (1 - SPRT.alpha));
export function sprtUpdate(llr: number, failed: boolean): number {
  const { p0, p1 } = SPRT;
  const inc = failed ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
  return Math.min(sprtUpper() + 1, Math.max(sprtLower() - 1, llr + inc));
}
// [6] HYSTERESIS. Demote and recover on different thresholds, so a provider hovering at the boundary
//     cannot oscillate once per observation — the classic Schmitt-trigger fix. Recovery is the LOWER
//     boundary of the same test, not a mirror of the upper one, so the gap is principled.
export const sprtVerdict = (llr: number): "dead" | "healthy" | "undecided" =>
  llr >= sprtUpper() ? "dead" : llr <= sprtLower() ? "healthy" : "undecided";

// [7] PROBE BUDGET. Probing costs provider quota that could have served a request, so the rate should
//     come from how fast belief decays, not from a round number. With ESS observations' worth of memory
//     and a target of keeping the estimate no more than one ESS stale, probe every provider once per
//     ESS * meanInterArrival. Returns probes per provider per hour.
export const probeRatePerHour = (essN = ess(), staleTargetMs = 15 * 60_000) =>
  Math.max(1, Math.round((3600_000 / staleTargetMs) * Math.min(1, essN / 9)));
