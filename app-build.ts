// Scheduler-driven app builds. The whole build is a chain of persisted steps, so it survives a closed
// tab, a dead network and the 50-60s invocation kill: whatever is unfinished is simply picked up by the
// next tick, from the cron val or from any HTTP request that drains the queue.
//
// THE SHAPE, and why each edge is what it is:
//
//   plan ──> build:a ─┐
//            build:b ─┼─> supervise ──> integrate ──> verify
//            build:c ─┘
//
//   plan       has no predecessor; it is the only step enqueued with real content up front.
//   build:*    do NOT exist until plan runs — the file list is the planner's OUTPUT. So they cannot be
//              wired as edges in advance; plan enqueues them dynamically.
//   supervise  waits for ALL builds. `needs` is a single FK and cannot express fan-in, so it waits on a
//              GATE instead: "no step of kind 'build' in this job is unfinished". A gate is a predicate
//              over a set, not an edge, so it does not care that the set did not exist at enqueue time.
//   integrate  needs=supervise AND gate='build'. That pair is the important one: if supervise schedules
//              repair builds, the gate RE-CLOSES and integrate waits again, with nothing rewired. An
//              open-ended repair loop falls out of the gate semantics for free.
//   verify     needs=integrate. Lints the assembled artifact and files what it finds.
//
// Every gated step also carries `needs` pointing at the step that CREATES its gated set — an empty gate
// set is trivially satisfied, so a gate without that edge fires immediately. scheduler.enqueue() rejects
// that combination outright rather than leaving it to be remembered.
import { stepMs } from "./timing.ts";
import { all, one, raw, run, sql } from "./db.ts";
import { enqueue, jobStatus, registerHandler } from "./scheduler.ts";
import { directivesFor, supervise as runSupervise } from "./brain.ts";
import { lintArtifact, listFiles, missingRefs, saveMany } from "./artifacts.ts";
import { PLACEHOLDER_MARK } from "./app-swarm.ts";
import { diffPlans, jobStepBudget, planOrder, taskDurations, taskGraph, type TaskRow, validatePlan } from "./plan.ts";

export const jobIdFor = (session: string, artifactId: number | string) => `build:${session}:${artifactId}`;
/** A build's own id, derived from the ASK.
 *
 *  startBuild defaulted its artifactHint to the literal "new", so every build a session ever ran shared
 *  the id `build:<session>:new`. Two builds in one session were therefore ONE job, and both outcomes
 *  were fatal:
 *    - while the first was in flight, the pending>0 guard handed the second ask the FIRST job, so the
 *      new request was silently dropped and the reply listed the previous app's files;
 *    - once it had finished, the second build's steps went into the same job, where dedupe keys are
 *      scoped per job - so `build:index.html` already existed and was skipped, and the second app was
 *      served the FIRST app's index.html while reporting itself 3/3 complete.
 *  Keying on the ask keeps the property the guard actually wanted - the same ask re-sent is a retry of
 *  one job, not a second app - while making different asks different jobs. FNV-1a, because this needs to
 *  be short, stable across isolates and deterministic, not cryptographic. */
export function askKey(ask: string): string {
  let h = 0x811c9dc5;
  const t = String(ask ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "new-" + h.toString(36);
}
const stateKey = (job: string) => `jobstate:${job}`;
/** How many times verify may re-enqueue builds for files the manifest planned but the artifact lacks.
 *  Bounded because a file the model genuinely cannot produce has to end as a visible failure. */
const VERIFY_ROUNDS = 3;
/** The plan-time shell is present and non-empty but is not a built file. Counting it meant a build that
 *  produced nothing at all still reported index.html as done. */
const isBuilt = (content: unknown) => {
  const t = String(content ?? "").trim();
  return t.length > 0 && !t.includes(PLACEHOLDER_MARK);
};

/** The manifest is written ONCE per job and read by every later step, rather than copied into each
 *  build step's payload: with 16 files a duplicated manifest is 16 copies of the same blob in the queue,
 *  and the payload column is the thing a WAF-sized body would have to carry. */
export const JOB_STATE_MAX = 200_000;

/** Fit a job state under the cap WITHOUT corrupting it.
 *
 *  This used to be `JSON.stringify(state).slice(0, 200_000)`. Slicing serialized JSON does not produce
 *  smaller JSON, it produces a string that is not JSON — cut mid-token, mid-escape, with every brace
 *  still open. getJobState then JSON.parses it inside a try/catch and returns null, and the next step
 *  throws "no job state for <job>" and the whole build dies, for the entirely recoverable sin of having
 *  a large manifest. A size guard that silently destroys the thing it is guarding is worse than no guard.
 *
 *  So shrink by DROPPING the biggest recoverable fields, in the order they are least needed, and
 *  re-serialize every time: whatever comes out is always valid JSON. `design` and `manifest` are
 *  regenerable (the design step reuses what it finds, the plan step rewrites it); the identity fields —
 *  session, artifactId, ask — are never dropped, because losing those loses the job. */
export function fitJobState(state: any, cap = JOB_STATE_MAX): { json: string; dropped: string[] } {
  let json = JSON.stringify(state ?? {});
  if (json.length <= cap) return { json, dropped: [] };
  const dropped: string[] = [];
  const next = { ...(state ?? {}) };
  // Largest and most regenerable first; `ask`, `session` and `artifactId` are not in this list on purpose.
  for (const field of ["conform", "issues", "missing", "design", "manifest"]) {
    if (!(field in next)) continue;
    delete next[field];
    dropped.push(field);
    json = JSON.stringify({ ...next, truncated: dropped });
    if (json.length <= cap) return { json, dropped };
  }
  // Nothing left to drop and still too large: keep only what identifies the job, which at least parses.
  const minimal = { session: next.session, artifactId: next.artifactId, ask: String(next.ask ?? "").slice(0, 2000), truncated: [...dropped, "everything else"] };
  return { json: JSON.stringify(minimal), dropped: minimal.truncated };
}

export async function putJobState(job: string, state: unknown): Promise<void> {
  const { json, dropped } = fitJobState(state);
  if (dropped.length) console.warn(`[build] job state for ${job} exceeded ${JOB_STATE_MAX} chars; dropped ${dropped.join(", ")}`);
  const w = await run(sql`INSERT INTO omni_state (key, value, ts) VALUES (${stateKey(job)}, ${json}, ${Date.now()})
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`);
  // A job whose state did not persist will fail its NEXT step with "no job state", far from the cause.
  if (!w.ok) console.error(`[build] job state for ${job} was not written:`, w.error);
}
export async function getJobState(job: string): Promise<any> {
  const r = await one("omni_state", sql`SELECT * FROM omni_state WHERE key = ${stateKey(job)}`);
  if (!r.ok || !r.value) return null;
  try { return JSON.parse((r.value as any).value); } catch { return null; }
}

export type BuildDeps = {
  conform: (job: string, st: any, deadline: number) => Promise<{ matches: boolean; built: string; mismatches: string[]; extra: string[] }>;
  design: (job: string, st: any, deadline: number) => Promise<{ design: string }>;
  plan: (job: string, st: any, deadline: number) => Promise<{ manifest: any; artifactId: number }>;
  buildFile: (job: string, st: any, path: string, directives: string[], deadline: number) => Promise<{ issues: string[]; truncated: boolean }>;
  integrate: (job: string, st: any, issues: string[], deadline: number) => Promise<unknown>;
};

/** Start a build. Returns the job id; nothing runs yet — the next tick drains it. */
export async function startBuild(session: string, ask: string, settings: any = {}, artifactHint: number | string | null = null): Promise<string> {
  const job = jobIdFor(session, artifactHint ?? askKey(ask));
  const existing = await jobStatus(job);
  if (existing.pending > 0) return job; // already in flight; never double-schedule the same build
  // SUPERSEDE. Asks are keyed by their text, so a new ask starts a new job while the previous one may
  // still have ready tasks queued — two live jobs in one session, writing different apps, both driven by
  // the same client poll, both spending the model budget. The old one is abandoned, not paused, so its
  // unstarted tasks are marked rather than left to surface later as work nobody asked for.
  await supersedeOtherJobs(session, job);
  // Settings live in job state, not in each step's payload: a step may run minutes later in a different
  // isolate, long after the request that carried them is gone.
  await putJobState(job, { session, ask, settings, startedAt: Date.now() });
  // THE PIPELINE: design -> plan -> build:* (parallel) -> supervise -> integrate -> verify.
  // Design is its own step because it is the only stage whose output every later stage reads, and
  // because a 30s design call must not share an invocation with a 30s planning call.
  const [designId] = await enqueue(job, [{ kind: "design", payload: { job }, seq: -10 }]);
  const [planId] = await enqueue(job, [{ kind: "plan", payload: { job, session, ask }, seq: 0, needs: designId }]);
  const [supId] = await enqueue(job, [{ kind: "supervise", payload: { job }, seq: 90, needs: planId, gate: "build", priority: 5 }]);
  const [intId] = await enqueue(job, [{ kind: "integrate", payload: { job }, seq: 95, needs: supId, gate: "build" }]);
  const [verId] = await enqueue(job, [{ kind: "verify", payload: { job }, seq: 99, needs: intId }]);
  // LAST WORD GOES TO THE ORIGINAL REQUEST. verify answers "does the artifact contain every file the
  // manifest planned" - but the manifest is downstream of a model's restatement of the ask, so a build
  // that drifted satisfies it perfectly. conform is the only step that reads what the user typed.
  await enqueue(job, [{ kind: "conform", payload: { job }, seq: 100, needs: verId }]);
  return job;
}

/** Start a REPAIR of an artifact that already exists.
 *
 *  A build plans a file list from nothing. A repair reads the file list that is already there and works
 *  out which of those files is broken - so it enters the SAME graph one stage later:
 *
 *    diagnose ──> build:<broken a> ─┐
 *                build:<broken b> ─┼─> supervise ──> integrate ──> verify
 *                build:<absent c> ─┘
 *
 *  Same job id namespace, same step kinds, same buildProgress shape, so the client driver and the whole
 *  verify/repair loop work on it unchanged. "look at the errors and finish the app files" used to run
 *  inline in one turn against a 26-message context and 14 tools, which is the request that kept dying.
 */
export async function startRepair(session: string, artifactId: number, ask: string, settings: any = {}): Promise<string> {
  const job = jobIdFor(session, artifactId);
  const existing = await jobStatus(job);
  if (existing.pending > 0) return job;
  const prior = await getJobState(job);
  // Keep a design document from an earlier build of THIS artifact: the files being repaired were written
  // against it, and a repair that ignores it reinterprets the domain.
  const ids: number[] = [];
  const put = (extra: unknown) => putJobState(job, { ...(prior ?? {}), session, artifactId, ask, settings, repair: extra });
  await put({ errors: String(ask).slice(0, 4000), startedAt: Date.now(), hadPrior: !!prior, stepIds: ids });
  const [diagId] = await enqueue(job, [{ kind: "diagnose", payload: { job }, seq: -5 }]);
  const [supId] = await enqueue(job, [{ kind: "supervise", payload: { job }, seq: 90, needs: diagId, gate: "build", priority: 5 }]);
  const [intId] = await enqueue(job, [{ kind: "integrate", payload: { job }, seq: 95, needs: supId, gate: "build" }]);
  const [verId] = await enqueue(job, [{ kind: "verify", payload: { job }, seq: 99, needs: intId }]);
  const [conId] = await enqueue(job, [{ kind: "conform", payload: { job }, seq: 100, needs: verId }]);
  ids.push(diagId, supId, intId, verId, conId);
  // The ids are recorded so an abandoned repair can be un-done EXACTLY. This job id is shared with any
  // earlier build of the same artifact, so "delete this job's steps" would erase that build's history.
  await put({ errors: String(ask).slice(0, 4000), startedAt: Date.now(), hadPrior: !!prior, stepIds: ids });
  return job;
}

/** Un-do a repair that turned out to have nothing to do. A scheduled job that will do no work is worse
 *  than never scheduling one: it answers a question with a progress card instead of an answer.
 *
 *  Deletes only the steps startRepair itself created, by id. The job id namespace is shared with any
 *  earlier build of the same artifact, so deleting "this job's steps" would erase that build's history. */
export async function cancelJob(job: string): Promise<number> {
  const st = await getJobState(job);
  const ids: number[] = (st?.repair?.stepIds ?? []).map(Number).filter(Number.isInteger);
  let removed = 0;
  for (const id of ids) {
    const r = await run(sql`DELETE FROM step WHERE id = ${id} AND job = ${job}`);
    if (r.ok) removed += Number((r.value as any)?.rowsAffected ?? 0);
  }
  if (st?.repair?.hadPrior) {
    const { repair: _dropped, ...rest } = st;
    await putJobState(job, rest);
  } else {
    await run(sql`DELETE FROM omni_state WHERE key = ${stateKey(job)}`);
  }
  return removed;
}

export function registerBuildHandlers(deps: BuildDeps): void {
  // diagnose - stage 1 of a REPAIR. No model call: what is broken is answerable from the files.
  //
  //   1. lintArtifact's findings, attributed to the file each one names.
  //   2. Files the user named in the ask (pasted console output names files).
  //   3. Files referenced by the HTML that DO NOT EXIST - the "404 or blocked" case. The file to write is
  //      the absent one, not the page that asks for it.
  //   4. Files that exist but are empty or still the plan-time placeholder.
  //
  // The synthetic manifest lists EVERY file, existing and absent, so verify reconciles against reality
  // and buildProgress reports against the real artifact - the repair targets are the build steps.
  registerHandler("diagnose", {
    maxMs: stepMs("diagnose"),
    run: async (p: { job: string }) => {
      const st = await getJobState(p.job);
      if (!st) throw new Error(`no job state for ${p.job}`);
      const id = Number(st.artifactId);
      const lf = Number.isInteger(id) && id > 0 ? await listFiles(id) : null;
      if (!lf) throw Object.assign(new Error(`artifact ${st.artifactId} has no files to repair`), { status: 400 });
      const ask = String(st.ask ?? "");

      const findings: Record<string, string[]> = {};
      const note = (path: string, msg: string) => { (findings[path] ??= []).push(msg); };
      for (const issue of lintArtifact(lf.files)) {
        const m = /^([^\s:]+):\s*(.+)$/.exec(issue);
        if (m && lf.files.some((f) => f.path === m[1])) note(m[1], m[2]);
      }
      const absent = missingRefs(lf.files);
      for (const a of absent) note(a.path, `this file does not exist but ${a.referrers.join(", ")} loads it — that is the 404; write the file`);
      for (const f of lf.files) {
        if (!isBuilt(f.content)) note(f.path, "the file is empty or still the plan-time placeholder — write its real contents");
        else if (ask.includes(f.path)) note(f.path, "named in the reported errors");
      }

      const targets = Object.keys(findings);
      const known = new Set(lf.files.map((f) => f.path));
      const title = String(st.title ?? "") || "repair";
      const manifest = {
        title,
        features: [],
        files: [...lf.files.map((f) => f.path), ...absent.map((a) => a.path)].map((path) => ({
          path,
          purpose: known.has(path)
            ? (findings[path] ? "EXISTING FILE — repair only what the findings name; keep everything else" : "existing file — already correct, not being rebuilt")
            : `MISSING FILE — referenced by the page but absent; write it`,
          exports: [], imports: [], notes: (findings[path] ?? []).join("; "),
        })),
      };
      await putJobState(p.job, { ...st, manifest, title, repair: { ...(st.repair ?? {}), findings, targets } });
      if (!targets.length) return { targets: 0, note: "nothing structurally wrong was found in this artifact" };
      await enqueue(p.job, targets.map((path, i) => ({
        kind: "build", payload: { job: p.job, path }, seq: 10 + i, dedupe: `repair:${path}`,
      })));
      return { targets: targets.length, files: targets, absent: absent.map((a) => a.path) };
    },
  });

  // conform — the honesty check. Everything before this judges the build against the PLAN; this judges
  // it against the REQUEST, which is the only thing the user actually wrote.
  registerHandler("conform", {
    maxMs: stepMs("conform"),
    run: async (p: { job: string }, ctx) => {
      const st = await getJobState(p.job);
      if (!st?.artifactId) return { skipped: "no artifact to judge" };
      const v = await deps.conform(p.job, st, ctx.deadline);
      await putJobState(p.job, { ...st, conform: { ...v, ts: Date.now() } });
      return v;
    },
  });

  // design - stage 1. One document, stored in job state, read by the planner and by every builder.
  registerHandler("design", {
    maxMs: stepMs("design"),
    run: async (p: { job: string }, ctx) => {
      const st = await getJobState(p.job);
      if (!st) throw new Error(`no job state for ${p.job}`);
      if (typeof st.design === "string" && st.design.length > 200) return { reused: true, chars: st.design.length };
      const { design } = await deps.design(p.job, st, ctx.deadline);
      await putJobState(p.job, { ...st, design });
      return { chars: design.length, headings: (design.match(/^#+ /gm) ?? []).length };
    },
  });

  // plan — the only step that fans out. Its output IS the rest of the graph.
  registerHandler("plan", {
    maxMs: stepMs("plan"),
    run: async (p: { job: string; session: string; ask: string }, ctx) => {
      const st0 = await getJobState(p.job);
      if (!st0) throw new Error(`no job state for ${p.job}`);
      const { manifest, artifactId } = await deps.plan(p.job, st0, ctx.deadline);
      if (st0.artifactId && artifactId !== st0.artifactId) throw new Error(`plan produced artifact ${artifactId} but this job already owns ${st0.artifactId}`);
      const files: string[] = (manifest?.files ?? []).map((f: any) => String(f.path)).filter(Boolean);
      if (!files.length) throw Object.assign(new Error("planner produced no files"), { status: 503, retryable: true });

      // A PLAN THAT CANNOT BUILD IS REJECTED BEFORE ANY TASK EXISTS. Retryable, so the planner gets one
      // more attempt with the specific defects named, rather than twelve builders discovering them.
      const defects = validatePlan(manifest);
      if (defects.length) {
        throw Object.assign(new Error(`the plan cannot be built as written:\n${defects.map((d) => "- " + d).join("\n")}`), { status: 503, retryable: true });
      }

      // REPLAN: only build what actually changed. A re-plan used to rebuild every file, discarding work
      // that was already correct — a one-file amendment cost a whole build.
      const prior = st0.manifest as any;
      const delta = diffPlans(prior, manifest);
      const build = prior ? [...delta.added, ...delta.changed] : files;
      const st = { ...st0, artifactId, manifest, title: manifest?.title ?? "" };
      await putJobState(p.job, st);

      // ORDER BY THE PLAN'S OWN DEPENDENCY GRAPH. Every builder used to run in parallel with no
      // ordering, so the file DEFINING the shared store and the file USING it were written at the same
      // moment by two calls that could not see each other — the consumer had no choice but to invent the
      // API. A dependent is now gated on the tasks that produce what it imports, so it is written when
      // those files already exist and can be shown to it verbatim.
      const order = planOrder(manifest).filter((o) => build.includes(o.path));
      const idOf = new Map<string, number>();
      for (const o of order) {
        const deps = o.needs.map((d) => idOf.get(d)).filter((n): n is number => Number.isInteger(n));
        // `needs` holds ONE predecessor, so a file with several dependencies waits on its deepest one —
        // which, because the order is topological, is the last of them to be enqueued.
        const [id] = await enqueue(p.job, [{
          kind: "build",
          payload: { job: p.job, path: o.path },
          seq: 10 + o.depth * 10,
          priority: o.priority,
          needs: deps.length ? deps[deps.length - 1] : null,
          dedupe: `build:${o.path}`,
        }]);
        idOf.set(o.path, id);
      }
      return { artifactId, files: order.length, skipped: prior ? delta.unchanged.length : 0, budget: jobStepBudget(files.length) };
    },
  });

  // build — one file, independent of its siblings, so these are the steps that actually parallelise.
  registerHandler("build", {
    maxMs: stepMs("build"),
    run: async (p: { job: string; path: string }, ctx) => {
      const st = await getJobState(p.job);
      if (!st?.manifest) throw new Error("no manifest for job; plan must run first");
      const directives = await directivesFor(p.job); // the supervisor's accumulated instructions
      const r = await deps.buildFile(p.job, st, p.path, directives, ctx.deadline);
      return { path: p.path, issues: r.issues, truncated: r.truncated };
    },
  });

  // supervise — reads every build outcome, may add directives and repair steps. Adding a 'build' step
  // here re-closes integrate's gate automatically.
  registerHandler("supervise", {
    maxMs: stepMs("supervise"),
    run: async (p: { job: string }) => runSupervise(p.job),
  });

  registerHandler("integrate", {
    maxMs: stepMs("integrate"),
    run: async (p: { job: string }, ctx) => {
      const st = await getJobState(p.job);
      if (!st?.artifactId) throw new Error("no artifact for job");
      const lf = await listFiles(st.artifactId);
      const issues = lf ? lintArtifact(lf.files) : [];
      return await deps.integrate(p.job, st, issues, ctx.deadline);
    },
  });

  // VERIFY RECONCILES AGAINST THE MANIFEST. It used to lint whatever files happened to exist and return
  // ok: issues.length === 0 - so a build that planned 12 files, produced 3, and had no lint complaints
  // about those 3 reported a clean, successful, finished build. The manifest, which is the only record of
  // what was supposed to exist, was never consulted. "The files I made are fine" is not "I made the files".
  //
  // When files are missing it does not just report them: it re-enqueues a build step for each one plus a
  // fresh verify gated on 'build'. The gate re-closes automatically, so the repair loop falls out of the
  // scheduler's existing semantics with nothing new to coordinate. VERIFY_ROUNDS bounds it, because a file
  // the model genuinely cannot produce must end as a visible failure, not an infinite rebuild.
  registerHandler("verify", {
    maxMs: stepMs("verify"),
    run: async (p: { job: string; round?: number }) => {
      const round = Number(p.round ?? 0);
      const st = await getJobState(p.job);
      const lf = st?.artifactId ? await listFiles(st.artifactId) : null;
      if (!lf) {
        await putJobState(p.job, { ...st, finishedAt: Date.now(), complete: false, issues: ["artifact missing"] });
        return { ok: false, complete: false, issues: ["artifact missing"] };
      }
      const planned: string[] = await plannedPathsFor(p.job, st);
      const have = new Map(lf.files.filter((f) => isBuilt(f.content)).map((f) => [f.path, f.content]));
      // "Present but empty" counts as missing. A zero-byte file satisfies a filename check and nothing else.
      const missing = planned.filter((path) => !have.has(path));
      const issues = lintArtifact(lf.files);
      const complete = planned.length > 0 && missing.length === 0;

      // A JOB MAY NOT CREATE UNBOUNDED WORK. verify re-enqueues a build per missing file for 3 rounds,
      // and the supervisor adds up to 4 per pass for 8 passes — neither knew about the other, so the
      // only ceiling was the scheduler's global queue-depth refusal, which protects the QUEUE, not this
      // job. A job that has spent its budget is not one more task away from working.
      const spent = await stepCount(p.job);
      const budget = jobStepBudget(planned.length);
      if (missing.length && spent >= budget) {
        await putJobState(p.job, { ...st, finishedAt: Date.now(), complete: false, missing, issues });
        return { ok: false, complete: false, planned: planned.length, built: planned.length - missing.length, missing, issues, stoppedBy: `this job has run ${spent} tasks against a budget of ${budget}; ${missing.length} file(s) were never produced` };
      }
      if (missing.length && round < VERIFY_ROUNDS) {
        const ids = await enqueue(p.job, missing.map((path, i) => ({
          kind: "build",
          payload: { job: p.job, path },
          seq: 200 + round * 100 + i,
          // Round-scoped dedupe: the original build:<path> key is already taken by the attempt that failed.
          dedupe: `rebuild:${round}:${path}`,
        })));
        const last = ids[ids.length - 1];
        await enqueue(p.job, [{ kind: "verify", payload: { job: p.job, round: round + 1 }, seq: 299 + round * 100, needs: last, gate: "build" }]);
        await putJobState(p.job, { ...st, complete: false, missing, issues });
        return { ok: false, complete: false, planned: planned.length, built: planned.length - missing.length, missing, rebuilding: missing.length, round };
      }

      await putJobState(p.job, { ...st, finishedAt: Date.now(), complete, missing, issues });
      return {
        ok: complete && issues.length === 0,
        complete,
        planned: planned.length,
        built: planned.length - missing.length,
        missing,
        issues,
        ...(missing.length ? { gaveUpAfterRounds: round } : {}),
      };
    },
  });
}

/** Abandon the unstarted tasks of every OTHER build job in this session.
 *
 *  Only ready tasks are touched: anything running keeps its lease (killing it mid-flight would orphan
 *  whatever it was writing), and anything done stays as history. */
export async function supersedeOtherJobs(session: string, keep: string): Promise<number> {
  const like = `build:${session}:%`;
  const r = await run(sql`UPDATE step SET status='skipped', error='superseded by a newer request in this session', lease_until=0, updated=${Date.now()}
                          WHERE job LIKE ${like} AND job <> ${keep} AND status='ready'`);
  return r.ok ? Number((r.value as any)?.rowsAffected ?? 0) : 0;
}

/** How many tasks this job has created so far, in any state. */
export async function stepCount(job: string): Promise<number> {
  // Was `SELECT id ... ` then `.length` — every row of a job pulled across the network to produce one
  // integer. A 24-file build is ~30 rows of payload JSON transferred to count to 30.
  const r = await raw<{ n: number }>(sql`SELECT COUNT(*) AS n FROM step WHERE job = ${job}`);
  return r.ok ? Number((r.value[0] as any)?.n ?? 0) : 0;
}

/** The job's tasks as a readable graph: what each one is, what it waits on, why it is waiting, and how
 *  long the finished ones took. Progress answered "how many files exist"; this answers "what is the
 *  system actually doing, and what is stuck behind what" — which is the question asked when it looks
 *  like nothing is happening. */
/** `rows` lets a caller that has already read this job's steps pass them in. ?build_status calls both
 *  this and buildProgress on every poll, and the two SELECTs differed only in their column list — so the
 *  route read the same rows from the network twice, concurrently, to build two views of them. */
export async function jobTasks(job: string, rows?: any[]) {
  const r = rows ? { ok: true as const, value: rows } : await all("step", sql`SELECT id, kind, status, payload, needs, gate, priority, created, updated, started, error FROM step WHERE job = ${job} ORDER BY seq, id`);
  const tasks = taskGraph((r.ok ? r.value : []) as unknown as TaskRow[]);
  return { job, tasks, durations: taskDurations(tasks), blocked: tasks.filter((t) => t.blockedBy).length };
}

/** Progress for the UI: counts by status plus the per-file rows, from the queue itself. */
/** WHAT THIS JOB SET OUT TO PRODUCE — for a build AND for a repair.
 *
 *  A build's plan lives in the manifest, written by the `plan` step. A REPAIR HAS NO PLAN STEP, by
 *  design: `diagnose` reads the artifact's actual breakage and fans out one `build` step per broken
 *  file. So for a repair the manifest is empty, and every consumer that derived "what was planned" from
 *  the manifest alone concluded that nothing was planned — which made `plannedFiles` 0, `builtFiles` 0,
 *  and, because both completion checks require `planned.length > 0`, made `complete` permanently FALSE
 *  no matter how completely the repair had succeeded.
 *
 *  Observed exactly that on artifact #7: all eight steps `done`, index.html (1082 bytes), main.js (3272)
 *  and style.css (776) written, all three build_file rows `ok` — and the UI stuck on
 *  "build — 0/0 files · polling 1/40" until the poll limit gave up, because the only numbers it had said
 *  nothing had been planned and therefore nothing could be complete.
 *
 *  The build STEPS are the plan when there is no manifest. They always were; nothing asked them. */
export async function plannedPathsFor(job: string, st: any, knownBuildPaths?: string[]): Promise<string[]> {
  const fromManifest: string[] = (st?.manifest?.files ?? []).map((f: any) => String(f.path)).filter(Boolean);
  if (fromManifest.length) return fromManifest;
  // buildProgress has already read every step row for this job, including the build payloads this
  // needs — re-querying for a strict subset of rows it is holding is a network round trip spent to
  // learn something already in memory, on a route the client polls every few seconds. Callers that
  // have the rows pass them; callers that do not (the verify handler) still get the query.
  if (knownBuildPaths) return [...new Set(knownBuildPaths.filter(Boolean))];
  const r = await all("step", sql`SELECT payload FROM step WHERE job = ${job} AND kind = 'build'`);
  const paths = ((r.ok ? r.value : []) as any[]).map((row) => {
    try { return String(JSON.parse(row.payload || "{}").path ?? ""); } catch { return ""; }
  }).filter(Boolean);
  return [...new Set(paths)];
}

export async function buildProgress(job: string, stepRows?: any[]) {
  // Independent, and this is the body of a route polled every few seconds: two sequential network waits
  // per poll became one. `stepRows` lets ?build_status hand over the rows it already read for jobTasks —
  // the two queries differed only in their column list, so the columns selected here are now the superset
  // both views need, read once.
  const [r, st] = await Promise.all([
    stepRows ? Promise.resolve({ ok: true as const, value: stepRows }) : all("step", sql`SELECT id, kind, status, payload, needs, gate, priority, created, updated, started, error FROM step WHERE job = ${job} ORDER BY seq, id`),
    getJobState(job),
  ]);
  const rows = (r.ok ? r.value : []) as any[];
  const by: Record<string, number> = {};
  for (const s of rows) by[s.status] = (by[s.status] ?? 0) + 1;
  const files = rows.filter((s) => s.kind === "build").map((s) => {
    let path = ""; try { path = JSON.parse(s.payload || "{}").path ?? ""; } catch { /* payload is opaque here */ }
    return { path, status: s.status, error: s.error };
  });
  // `done` means THE QUEUE DRAINED. It does not mean the build succeeded - a job whose build steps all
  // failed or got blocked also has nothing ready or running. Reporting only `done` is what let a 3-of-12
  // build present itself as finished. `complete` is the separate, honest question: does the artifact
  // actually contain every file the manifest planned?
  // These two do not depend on each other, and this function is the body of a route the client polls
  // every few seconds — so they were two sequential network waits per poll for no reason. `listFiles`
  // is skipped entirely when there is no artifact yet, exactly as before.
  //
  // Derived from the ARTIFACT, not from st.missing. Cached state is only as fresh as the last verify, so
  // before verify has run it reported missing:[] - i.e. "nothing missing" - for a build that had produced
  // three of twelve files. Progress must be answerable at any moment, not only after the final step.
  const [planned, lf] = await Promise.all([
    plannedPathsFor(job, st, files.map((f) => f.path)),
    st?.artifactId ? listFiles(Number(st.artifactId)) : Promise.resolve(null),
  ]);
  const present = new Set((lf?.files ?? []).filter((f) => isBuilt(f.content)).map((f) => f.path));
  const missing: string[] = planned.filter((path) => !present.has(path));
  const drained = (by.ready ?? 0) + (by.running ?? 0) === 0;
  return {
    job, by, files, artifactId: st?.artifactId ?? null, title: st?.title ?? "",
    done: drained,
    complete: drained && planned.length > 0 && missing.length === 0,
    plannedFiles: planned.length,
    builtFiles: Math.max(0, planned.length - missing.length),
    missing,
    failedSteps: (by.failed ?? 0) + (by.blocked ?? 0),
    // `complete` means every planned file exists. `conform` means the planned files were the right ones.
    // A build can be complete and wrong, and that combination is the whole reported complaint, so it is
    // reported separately rather than folded into one boolean that would have to lie about one of them.
    conform: st?.conform ?? null,
  };
}
