// The supervisor. Watches a running job, diagnoses why it is going wrong, rewrites the instructions the
// workers get, and schedules corrective work. Runs as an ordinary `supervise` step, so it is subject to
// the same budget and lease rules as everything else it supervises.
//
// Deliberately rule-first. Diagnosis is deterministic pattern-matching over step outcomes; the model is
// consulted only to phrase a better instruction, and never to decide WHETHER to act or HOW MUCH work to
// create. A supervisor that can both judge and spend is a runaway: it observes its own corrections
// failing, corrects harder, and converts a stuck build into an unbounded bill. Every actuator below is
// saturated — bounded directives, bounded new steps, bounded passes — and the caps are the point, not
// defensive decoration.
import { all, one, run, sql } from "./db.ts";
import { enqueue, MAX_ATTEMPTS } from "./scheduler.ts";

export const MAX_DIRECTIVES = 6;      // instruction text is a budget too: past ~6 added rules, workers start ignoring them
export const MAX_NEW_STEPS_PER_PASS = 4;
export const MAX_PASSES = 8;          // a job the supervisor cannot fix in 8 passes is not one more pass away

/** [18] MULTIPLE TESTING. The supervisor evaluates m rules against every step of every job, so with a
 *  per-rule false-positive rate alpha the family-wise error is ~1-(1-alpha)^m ~ m*alpha. At m=5 rules and
 *  the naive "3 occurrences is a pattern" threshold, spurious directives are not unlikely, they are
 *  expected — and a spurious directive permanently constrains every subsequent worker. Bonferroni: to
 *  hold family-wise error at alpha, test each rule at alpha/m, which for a geometric null (repeat
 *  failures i.i.d. w.p. q) raises the evidence threshold to ceil(log(alpha/m)/log(q)). With q=0.3,
 *  alpha=0.05, m=5 that is 4, not 3. Cheap to compute, and it is the difference between a supervisor
 *  that reacts to noise and one that reacts to signal. */
export const RULE_COUNT = 5;
export const FAMILY_ALPHA = 0.05;
export const NULL_REPEAT_Q = 0.3;
export const evidenceThreshold = (m = RULE_COUNT, alpha = FAMILY_ALPHA, q = NULL_REPEAT_Q) =>
  Math.max(2, Math.ceil(Math.log(alpha / m) / Math.log(q)));

export type Signal = { kind: string; subject: string; detail: string; count: number };
export type Finding = { rule: string; subject: string; why: string; directive?: string; steps?: { kind: string; payload: unknown }[] };

const key = (job: string) => `brain:${job}`;
type BrainState = { passes: number; directives: string[]; seen: string[]; lastFailures?: number; idlePasses?: number };

export async function brainState(job: string): Promise<BrainState> {
  const r = await one("omni_state", sql`SELECT * FROM omni_state WHERE key = ${key(job)}`);
  if (r.ok && r.value) { try { return JSON.parse((r.value as any).value); } catch { /* corrupt row: fall through to a fresh state rather than wedging the job */ } }
  return { passes: 0, directives: [], seen: [] };
}
const saveState = (job: string, s: BrainState) =>
  run(sql`INSERT INTO omni_state (key, value, ts) VALUES (${key(job)}, ${JSON.stringify(s)}, ${Date.now()})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`);

/** Extra instruction lines injected into every worker prompt for this job. Callers append these to the
 *  system/user prompt they were already going to send — the supervisor never rewrites a base prompt, it
 *  only adds constraints, so a bad directive degrades output rather than destroying the instruction. */
export async function directivesFor(job: string): Promise<string[]> {
  return (await brainState(job)).directives;
}

/** OBSERVE — everything the supervisor is allowed to know, read in one pass. */
export async function observe(job: string): Promise<Signal[]> {
  const out: Signal[] = [];
  const r = await all("step", sql`SELECT kind, status, attempts, error, payload FROM step WHERE job = ${job}`);
  const rows = (r.ok ? r.value : []) as any[];

  const byErr = new Map<string, { n: number; kinds: Set<string> }>();
  for (const s of rows) {
    if (!s.error) continue;
    const sig = String(s.error).slice(0, 80);
    const e = byErr.get(sig) ?? { n: 0, kinds: new Set<string>() };
    e.n++; e.kinds.add(s.kind); byErr.set(sig, e);
  }
  for (const [sig, e] of byErr) out.push({ kind: "repeated_error", subject: [...e.kinds].join(","), detail: sig, count: e.n });

  for (const s of rows) {
    if (s.attempts >= MAX_ATTEMPTS && s.status === "failed") out.push({ kind: "exhausted", subject: s.kind, detail: String(s.error ?? "").slice(0, 120), count: s.attempts });
    if (/truncat|max_tokens|output was cut/i.test(String(s.error ?? ""))) out.push({ kind: "truncated", subject: s.kind, detail: String(s.payload ?? "").slice(0, 80), count: 1 });
    if (/not owned by this run|find text not present|does not exist/i.test(String(s.error ?? ""))) out.push({ kind: "misdirected_write", subject: s.kind, detail: String(s.error).slice(0, 120), count: 1 });
  }
  const stuck = rows.filter((s) => s.status === "ready").length;
  const running = rows.filter((s) => s.status === "running").length;
  if (stuck > 0 && running === 0 && rows.some((s) => s.status === "failed")) out.push({ kind: "blocked_by_failure", subject: job, detail: `${stuck} ready, ${running} running`, count: stuck });
  return out;
}

/** DIAGNOSE — deterministic. Each rule names the directive it wants and the work it wants scheduled. */
export function diagnose(signals: Signal[]): Finding[] {
  const f: Finding[] = [];
  for (const s of signals) {
    if (s.kind === "truncated") {
      f.push({ rule: "split_oversized", subject: s.subject, why: `output truncated on ${s.subject}`,
        directive: "Keep each file under ~200 lines. If the file would be longer, emit the first coherent section only and stop cleanly — a later step completes it.",
        steps: [{ kind: "verify_file", payload: { hint: s.detail } }] });
    }
    if (s.kind === "misdirected_write") {
      f.push({ rule: "pin_target_path", subject: s.subject, why: s.detail,
        directive: "Write ONLY the exact file path named in your instruction. Never write index.html unless it is your named path. If you believe another file needs changing, say so in your reply instead of writing it." });
    }
    if (s.kind === "repeated_error" && s.count >= evidenceThreshold()) {
      f.push({ rule: "recurring_failure", subject: s.subject, why: `${s.count}x: ${s.detail}`,
        directive: `A previous attempt failed repeatedly with: "${s.detail}". Do not repeat that approach.` });
    }
    if (s.kind === "exhausted") {
      f.push({ rule: "give_up_visibly", subject: s.subject, why: `${s.subject} exhausted ${s.count} attempts`,
        steps: [{ kind: "report_blocked", payload: { step: s.subject, error: s.detail } }] });
    }
    if (s.kind === "blocked_by_failure") {
      f.push({ rule: "unblock", subject: s.subject, why: s.detail, steps: [{ kind: "report_blocked", payload: { job: s.subject, detail: s.detail } }] });
    }
  }
  return f;
}

/** ACT — apply findings under saturation. Returns what it actually did, which is not what it wanted. */
export async function supervise(job: string): Promise<{ passes: number; applied: Finding[]; directives: string[]; scheduled: number; capped: string[] }> {
  const st = await brainState(job);
  const capped: string[] = [];
  if (st.passes >= MAX_PASSES) return { passes: st.passes, applied: [], directives: st.directives, scheduled: 0, capped: ["max_passes"] };

  // [19] ANTI-WINDUP. A controller that keeps integrating while its output is saturated, or while its
  // corrections are not moving the plant, winds up: it accumulates ever-larger interventions for a system
  // that is not responding to them. Here that looks like directive after directive piled onto workers
  // that are failing for a reason no instruction can fix. So: measure whether the last intervention
  // actually reduced the failure count, and if two consecutive passes produced no improvement, stop
  // intervening and escalate instead. The supervisor's job includes knowing it is not helping.
  const signals = await observe(job);
  const failures = signals.reduce((a, s) => a + (s.kind === "exhausted" || s.kind === "repeated_error" ? s.count : 0), 0);
  const improved = st.lastFailures === undefined || failures < st.lastFailures;
  st.idlePasses = improved ? 0 : (st.idlePasses ?? 0) + 1;
  st.lastFailures = failures;
  if ((st.idlePasses ?? 0) >= 2) {
    st.passes++; await saveState(job, st);
    await enqueue(job, [{ kind: "report_blocked", payload: { job, reason: "supervisor made no progress over two passes; escalating instead of adding instructions", failures }, priority: 10, dedupe: `noprogress:${job}` }]);
    return { passes: st.passes, applied: [], directives: st.directives, scheduled: 1, capped: ["anti_windup"] };
  }

  // [20] DEAD BAND. Below a minimum evidence level the controller does nothing at all — implemented as
  // evidenceThreshold() inside diagnose(). Without one, a feedback loop with delay reacts to every
  // fluctuation and oscillates around the target instead of settling, and each oscillation here costs a
  // permanent directive and real model calls.
  const findings = diagnose(signals);
  const fresh = findings.filter((x) => !st.seen.includes(x.rule + "|" + x.subject)); // never act twice on the same finding
  const applied: Finding[] = [];
  let scheduled = 0;

  for (const x of fresh) {
    if (x.directive && !st.directives.includes(x.directive)) {
      if (st.directives.length >= MAX_DIRECTIVES) { capped.push("max_directives"); }
      else st.directives.push(x.directive);
    }
    if (x.steps?.length) {
      const room = MAX_NEW_STEPS_PER_PASS - scheduled;
      if (room <= 0) { capped.push("max_new_steps"); }
      else { const ids = await enqueue(job, x.steps.slice(0, room).map((s) => ({ kind: s.kind, payload: s.payload, priority: 10, dedupe: `${x.rule}:${x.subject}:${s.kind}` }))); scheduled += ids.length; }
    }
    st.seen.push(x.rule + "|" + x.subject);
    applied.push(x);
  }
  st.passes++;
  st.seen = st.seen.slice(-100);
  await saveState(job, st);
  return { passes: st.passes, applied, directives: st.directives, scheduled, capped: [...new Set(capped)] };
}

/** Wipe supervision state for a job — used when a build is restarted from scratch so stale directives
 *  from a previous run do not constrain a fresh attempt. */
export const resetBrain = (job: string) => run(sql`DELETE FROM omni_state WHERE key = ${key(job)}`);
