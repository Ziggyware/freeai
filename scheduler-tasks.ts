// Built-in step handlers. Each declares `maxMs` — the scheduler refuses to START a step it cannot let
// finish, so this number is a contract, not a hint: understate it and the step gets killed mid-flight and
// retried forever; overstate it and it never runs on a busy tick.
import { stepMs } from "./timing.ts";
import { all, run, sql } from "./db.ts";
import { getJobState } from "./app-build.ts";
import { lintArtifact, listFiles } from "./artifacts.ts";
import { registerHandler } from "./scheduler.ts";
import { getInstanceRoster } from "./router-core.ts";

/** Housekeeping. Steps are append-heavy; completed rows outnumber live ones within a day. */
registerHandler("retention", {
  maxMs: stepMs("retention"),
  run: async (p: { days?: number }) => {
    const cutoff = Date.now() - (p.days ?? 7) * 86_400_000;
    const a = await run(sql`DELETE FROM step WHERE status IN ('done','failed') AND updated < ${cutoff}`);
    const b = await run(sql`DELETE FROM progress WHERE ts < ${cutoff}`);
    // JOB STATE IS THE BIGGEST THING NOBODY WAS DELETING.
    //
    // putJobState writes up to 200,000 characters per job — manifest, design document, decisions,
    // conformance verdict — into omni_state under "jobstate:<job>", and nothing removed it, ever.
    // Retention swept `step` and `progress` and walked straight past the rows that are three orders of
    // magnitude larger. On the free tier's ~10 MB of SQLite that is roughly fifty builds before writes
    // start failing, and a database that is full does not announce itself: inserts return errors that
    // this codebase turns into values, so a build simply stops recording anything and looks stuck.
    //
    // A finished job's state is history, not working memory — the artifact and its files are the
    // durable output, and `?requests` reads this only to show recent asks. Sweeping it on the same
    // cutoff as everything else keeps the store bounded by TIME rather than by how much you have built.
    const c = await run(sql`DELETE FROM omni_state WHERE key LIKE 'jobstate:%' AND ts < ${cutoff}`);
    return {
      steps: a.ok ? a.value.rowsAffected : -1,
      progress: b.ok ? b.value.rowsAffected : -1,
      jobState: c.ok ? c.value.rowsAffected : -1,
    };
  },
});

/*  The scheduled health probe is GONE, not stubbed.
 *
 *  It used to select the stalest instances and return a note saying probing "is wired in the router",
 *  having issued no inference at all - a handler that reported success for work it never did. Keeping a
 *  registered no-op in its place was no better: it is exactly the placeholder the standing rule forbids.
 *
 *  Doing it properly needs a way to pin one inference to one named instance through the router, which is
 *  a router change. Until that exists there is nothing honest to run, so nothing is registered and
 *  nothing is scheduled. Rows queued by an older deploy are rewritten to "noop" by migrateProbeSteps()
 *  below, so removing the handler cannot strand them on "no handler registered for kind".  */

/** One-shot migration for queues built before the probe was removed. Cheap, idempotent, and it runs
 *  before any tick so an orphaned row can never fail a job it has nothing to do with. */
export async function migrateProbeSteps(): Promise<number> {
  const r = await run(sql`UPDATE step SET kind = 'noop' WHERE kind = 'probe' AND status IN ('ready','running')`);
  return r.ok ? r.value.rowsAffected : 0;
}

/** The supervisor pass. Bounded by brain.ts's own caps, so this cannot become the thing that never ends. */
// NOTE: "supervise", "plan", "build", "integrate" and "verify" are registered by
// registerBuildHandlers() in app-build.ts, which closes over the inference dependencies that live in
// app.tsx (PassMeter, prompts). Registering a build-aware "supervise" here too would shadow it, so the
// generic one is gone: brain.supervise() is reachable through app-build's registration.

/** Terminal, deliberately non-retrying: records that a job could not proceed so the failure is visible
 *  in the UI instead of being an absence of progress. */
registerHandler("report_blocked", {
  maxMs: stepMs("report_blocked"),
  run: async (p: Record<string, unknown>, ctx) => {
    await run(sql`INSERT INTO omni_state (key, value, ts) VALUES (${"blocked:" + ctx.step.job}, ${JSON.stringify(p).slice(0, 2000)}, ${Date.now()})
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`);
    return { reported: true, ...p };
  },
});

/** Supervisor-scheduled verification of the job's artifact.
 *
 *  This returned `{ verified: false, reason: "no file verifier wired yet" }` unconditionally - and
 *  SUCCEEDED while doing it, so the supervisor recorded a completed verification step that had checked
 *  nothing. A check that cannot fail is worse than no check, because it reads as evidence.
 *
 *  It now runs the real cross-file lint over the job's artifact. The job comes from the step row rather
 *  than the payload, so it needs nothing the supervisor does not already set. It still resolves rather
 *  than throwing when it finds defects: FINDING issues is a successful verification, and failing here
 *  would trip the supervisor's own recurring-failure rule and stall the job over a working check. */
registerHandler("verify_file", {
  maxMs: stepMs("verify_file"),
  run: async (p: { hint?: string; path?: string }, ctx) => {
    const st = await getJobState(ctx.step.job);
    const id = Number(st?.artifactId);
    if (!Number.isInteger(id)) return { verified: false, reason: `job ${ctx.step.job} has no artifact yet`, hint: p.hint ?? null };
    const lf = await listFiles(id);
    if (!lf) return { verified: false, reason: `artifact ${id} not found`, hint: p.hint ?? null };
    const all_ = lintArtifact(lf.files);
    const scoped = p.path ? all_.filter((i) => i.startsWith(p.path + ":")) : all_;
    return { verified: true, artifactId: id, files: lf.files.length, issues: scoped, clean: scoped.length === 0, hint: p.hint ?? null };
  },
});

/** Anything queued for a kind that no longer exists would otherwise fail permanently on every tick. */
registerHandler("noop", { maxMs: stepMs("noop"), run: async () => ({ ok: true }) });

export const scheduledJobCounts = async () => {
  const r = await all("step", sql`SELECT status, COUNT(*) AS n FROM step GROUP BY status`);
  const by: Record<string, number> = {};
  for (const row of (r.ok ? r.value : []) as any[]) by[row.status] = Number(row.n);
  return by;
};
