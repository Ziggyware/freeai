// Val Town interval file (fileType: "interval"). Set the cron expression in the val's interval settings;
// every-minute or every-few-minutes is the intended cadence. Cron expressions are evaluated in UTC.
//
// This is the clock-driven driver for the step queue. It is not the only one — any HTTP handler may also
// call tick() to opportunistically drain a step — but it is the one that guarantees progress when nobody
// is using the app, which is what makes long jobs finish rather than stalling until the next visitor.
//
// Budget: a tick asks for 40s against Val Town's ~50-60s kill. The remainder is not slack, it is the
// margin the scheduler needs to record results for the step it just ran; spending it is how a completed
// step gets marked ready again and repeats forever.
import { T } from "./timing.ts";
import { initDB, sql, run, one } from "./db.ts";
import { nextRunAt, tick, enqueue, jobStatus } from "./scheduler.ts";
import { migrateProbeSteps } from "./scheduler-tasks.ts"; // also registers handlers as a side effect — must be imported before tick()
import { installHandlers } from "./app-boot.ts";        // build/repair kinds too: a cron isolate must be able to run them

const TICK_BUDGET_MS = T.cronTick;
const MAINT_JOB = "maintenance";
const MAINT_EVERY_MS = 6 * 60 * 60_000;

/** Keep exactly one live maintenance chain. Re-enqueuing on every fire is how a queue quietly grows a
 *  million duplicate housekeeping steps; check first. */
async function ensureMaintenance(): Promise<boolean> {
  const st = await jobStatus(MAINT_JOB);
  if (st.pending > 0) return false;
  const last = await one("omni_state", sql`SELECT * FROM omni_state WHERE key = 'maint:last'`);
  const lastTs = last.ok && last.value ? Number((last.value as any).ts) : 0;
  if (Date.now() - lastTs < MAINT_EVERY_MS) return false;
  await enqueue(MAINT_JOB, [
    { kind: "retention", payload: { days: 7 } },
    { kind: "probe", payload: { n: 2, timeoutMs: 5_000 } },
  ]);
  await run(sql`INSERT INTO omni_state (key, value, ts) VALUES ('maint:last', '1', ${Date.now()})
                ON CONFLICT(key) DO UPDATE SET ts = excluded.ts`);
  return true;
}

export default async function (interval: { lastRunAt?: Date }) {
  await initDB();
  // A job left running by a closed tab reaches THIS isolate, where the generic handlers exist but the
  // build/repair kinds are registered by app-build.ts through the wire. Without this line every
  // design/plan/build/verify/goalcheck step failed here with "no handler registered for kind".
  installHandlers();
  await migrateProbeSteps().catch(() => 0); // retire rows from before the probe handler was removed
  const queued = await ensureMaintenance();
  const report = await tick(TICK_BUDGET_MS);
  const next = await nextRunAt();
  const out = {
    lastRunAt: interval?.lastRunAt ?? null,
    queuedMaintenance: queued,
    ...report,
    nextRunAt: next ? new Date(next).toISOString() : null,
  };
  // Visible in the val's logs; the same numbers are queryable from the step table for the UI.
  console.log("[scheduler]", JSON.stringify(out));
  return out;
}
