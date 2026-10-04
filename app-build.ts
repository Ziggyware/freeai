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
import { lintArtifact, listFiles, missingRefs } from "./artifacts.ts";
import { healAndSave, issuePath } from "./heal.ts";
import { PLACEHOLDER_MARK } from "./app-swarm.ts";
import { diffPlans, jobStepBudget, planOrder, taskDurations, taskGraph, type TaskRow, validatePlan } from "./plan.ts";
import { MAX_REPAIR_ROUNDS, fingerprint, localImports, parseRepairAsk, pickRepairTargets, repairGoal, type RepairPick } from "./repair.ts";

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
  /** REPAIR one file: the smallest correct edit plus the root cause, never a fresh rewrite.
   *
   *  Separate from buildFile because they are different operations with different acceptance tests. A
   *  builder is handed a purpose line and asked for a complete file; a repairer is handed the file, the
   *  defect and the reported failure, and asked for the minimal edit that removes the defect. Routing a
   *  fix through the builder is how "apply the smallest correct fix" became a wholesale rewrite that
   *  left the bug in place. */
  repairFile: (job: string, st: any, path: string, deadline: number) => Promise<{ issues: string[]; truncated: boolean; changed: boolean; rootCause: string }>;
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
  // A job that is already running is JOINED, not restarted: re-enqueuing the same repair while the first
  // attempt is in flight would run every step twice against the same files.
  if (existing.pending > 0) return job;
  const prior = await getJobState(job);
  // Keep a design document from an earlier build of THIS artifact: the files being repaired were written
  // against it, and a repair that ignores it reinterprets the domain.
  const ids: number[] = [];
  const ask0 = String(ask).slice(0, 4000);
  // A new ask un-stops the job even when an earlier run of it was stopped by hand: this turn IS the user
  // asking for it. (The stop flag only ever suppresses FUTURE rounds; it never resurrects them.)
  const stopped = false;
  const put = (extra: unknown) => putJobState(job, { ...(prior ?? {}), session, artifactId, ask, settings, repair: extra });
  // ROUNDS AND OUTCOME ARE PART OF THE REPAIR, not derived later. `round` is which attempt this is,
  // `maxRounds` the ceiling, `resolved` the acceptance test's verdict and `stopped` the user's. Without
  // them the only terminal state a repair could reach was "the queue drained", which is exactly what the
  // reported run reported while the bug was still in the file.
  const startedAt = Date.now();
  await put({ errors: ask0, startedAt, hadPrior: !!prior, stepIds: ids, round: 0, maxRounds: MAX_REPAIR_ROUNDS, stopped, resolved: false, rootCauses: {} });
  // ONE IDENTITY PER REPAIR RUN. `job` is reused for every repair of the same artifact (that is deliberate:
  // one progress card, one history), which means a round-scoped dedupe key like "repair-round:1" already
  // exists from the PREVIOUS run - `enqueue` would answer with that completed step's id and the new repair
  // would enqueue nothing and finish instantly. Every key the loop creates carries this run key, so a
  // second repair is a second run, not a dedupe hit.
  const [diagId] = await enqueue(job, [{ kind: "diagnose", payload: { job }, seq: -5 }]);
  const runKey = `${startedAt}:${diagId}`;
  const [supId] = await enqueue(job, [{ kind: "supervise", payload: { job }, seq: 90, needs: diagId, gate: "build", priority: 5 }]);
  const [intId] = await enqueue(job, [{ kind: "integrate", payload: { job }, seq: 95, needs: supId, gate: "build" }]);
  const [verId] = await enqueue(job, [{ kind: "verify", payload: { job }, seq: 99, needs: intId }]);
  // The conformance step is NOT enqueued for a repair. It compares the artifact against the ask as if the
  // ask were a build order — "fix render.js:27" is not a description of an app, so it reported a mismatch
  // every time and did nothing with the verdict. A repair's acceptance test is whether the reported
  // failure is gone, and `goalcheck` is that test: deterministic, re-run after every round, and the only
  // thing allowed to declare the repair finished.
  // DEDUPE, because verify enqueues a goalcheck for the same round once it has recorded the verdict. Two
  // goalchecks for one round would advance the round counter twice and spend two rounds' budget on one
  // attempt. The key is per (run, round), so the second enqueue returns the first step's id.
  const [goalId] = await enqueue(job, [{ kind: "goalcheck", payload: { job, round: 0 }, seq: 99.5, needs: verId, priority: 3, dedupe: `goalcheck:${runKey}:0` }]);
  ids.push(diagId, supId, intId, verId, goalId);
  // The ids are recorded so an abandoned repair can be un-done EXACTLY. This job id is shared with any
  // earlier build of the same artifact, so "delete this job's steps" would erase that build's history.
  await put({ errors: ask0, startedAt, hadPrior: !!prior, stepIds: ids, firstStepId: diagId, runKey, round: 0, maxRounds: MAX_REPAIR_ROUNDS, stopped, resolved: false, rootCauses: {} });
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
    run: async (p: { job: string; round?: number }) => {
      const st = await getJobState(p.job);
      if (!st) throw new Error(`no job state for ${p.job}`);
      const id = Number(st.artifactId);
      const lf = Number.isInteger(id) && id > 0 ? await listFiles(id) : null;
      if (!lf) throw Object.assign(new Error(`artifact ${st.artifactId} has no files to repair`), { status: 400 });
      const ask = String(st.ask ?? "");
      const repair = st.repair ?? {};
      const round = Math.max(0, Number(p.round ?? repair.round ?? 0));

      // WHO DECIDES WHAT TO FIX: THE ASK, THEN THE LINT. The old version derived targets from the lint
      // and merely *noted* files the ask happened to name (`ask.includes(f.path)`), so a report about
      // `render.js:27` queued rebuilds of index.html and manifest.json and treated render.js as one
      // target among three. The rules — and why each one exists — live in repair.ts.
      const parsed = parseRepairAsk(ask, String(repair.focusFile ?? st.settings?.focus?.file ?? ""));
      const missing = missingRefs(lf.files);
      const pick: RepairPick = pickRepairTargets({ ask: parsed, askText: ask, known: lf.files.map((f) => f.path), lint: lintArtifact(lf.files), missing });
      const goal = repairGoal(ask, pick);

      // ROUND 2+ ONLY RE-TOUCHES WHAT IS STILL BROKEN. Re-repairing a file that the previous round
      // already fixed is how a loop introduces the next regression.
      const stillBroken: string[] = (repair.unresolved ?? []).map(String);
      const todo = round > 0 && stillBroken.length ? pick.targets.filter((t) => stillBroken.includes(t)) : pick.targets;

      const findings: Record<string, string[]> = { ...pick.findings };
      const note = (path: string, msg: string) => { (findings[path] ??= []).push(msg); };
      // ROUND 2+ SAYS WHAT ROUND 1 GOT WRONG. Otherwise the next repair call is the same prompt the model
      // already failed to act on — a retry, not a new attempt. The `why` comes from the deterministic
      // verdict: missing, still-linting, or byte-identical after a round that claimed to fix it.
      for (const [path, reason] of Object.entries<any>(repair.why ?? {})) {
        if (todo.includes(path) && reason) note(path, `the previous repair round did not fix it: ${String(reason)}`);
      }
      const known = new Set(lf.files.map((f) => f.path));
      const byPath = new Map(lf.files.map((f) => [f.path, f.content]));
      // Content identity at the START of this round: "did the round change anything" is answered by
      // comparing against this, and it is the only available proof that a repair did work. (The reported
      // runtime error is a browser observation this system cannot re-observe.)
      // `roundStart` covers exactly the files this round ATTEMPTS. Covering every target instead would
      // mark a file that was fixed in round 1 as "unchanged" in round 2 — it was not attempted again, so
      // it cannot have changed — and the loop would never accept its own success.
      const roundStart: Record<string, string> = {};
      for (const t of todo) roundStart[t] = fingerprint(byPath.get(t) ?? "");
      const title = String(st.title ?? "") || "repair";
      // The manifest is rebuilt from the files that exist, but the DEPENDENCY FACTS come from the plan that
      // wrote them: `exports`/`imports` per path are what the repair prompt and the dependency brief read,
      // and dropping them (this used to write empty arrays) is why a repair could not see the module its
      // target imports.
      const priorSpecs = new Map<string, any>(((st.manifest?.files ?? []) as any[]).map((f) => [String(f.path), f]));
      const manifest = {
        title,
        features: [],
        files: [...new Set([...lf.files.map((f) => f.path), ...pick.absent])].map((path) => ({
          path,
          purpose: known.has(path)
            ? (pick.targets.includes(path) ? "EXISTING FILE — repair only what the findings name; keep everything else" : "existing file — already correct, not being rebuilt")
            : `MISSING FILE — referenced by the page but absent; write it`,
          exports: priorSpecs.get(path)?.exports ?? [],
          imports: (priorSpecs.get(path)?.imports ?? []).length ? priorSpecs.get(path)?.imports ?? [] : localImports(byPath.get(path) ?? "", [...known, ...pick.absent], path),
          notes: (findings[path] ?? []).join("; "),
        })),
      };
      await putJobState(p.job, {
        ...st, manifest, title,
        repair: {
          ...repair, findings, targets: pick.targets, primary: pick.primary, untouched: pick.untouched,
          absent: pick.absent, scopedToAsk: pick.scopedToAsk, goal, round, maxRounds: Number(repair.maxRounds ?? MAX_REPAIR_ROUNDS),
          // `failed` is the UNION of every target that has ever come back unresolved. `unresolved` is reset at
          // the start of each round (it describes the CURRENT verdict), so it cannot answer "how much of this
          // repair is done" — and without that, progress reads "the file exists" (it always did) and never
          // moves. This is what builtFiles counts for a repair.
          failed: [...new Set([...(repair.failed ?? []), ...(repair.unresolved ?? [])].map(String))],
          roundTargets: todo, roundStart, checkedAt: Date.now(), unresolved: [], resolved: false,
        },
      });
      if (!todo.length) {
        return { targets: 0, round, note: pick.targets.length ? "every target of this round was already repaired" : "nothing structurally wrong was found in this artifact" };
      }
      await enqueue(p.job, todo.map((path, i) => ({
        kind: "build", payload: { job: p.job, path, repair: true }, seq: 10 + i,
        // RUN-scoped AND round-scoped: the same file is repaired again in a later round (and the same
        // round number exists in an earlier repair run of this artifact, because the job id is reused),
        // so a key of just (round, path) would be a dedupe hit against a completed step from last time -
        // the round would enqueue nothing and finish having done nothing.
        dedupe: `repair:${repair.runKey ?? "0:0"}:${round}:${path}`,
      })));
      return { targets: todo.length, round, files: todo, absent: pick.absent, goal };
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
    run: async (p: { job: string; path: string; repair?: boolean }, ctx) => {
      const st = await getJobState(p.job);
      if (!st?.manifest) throw new Error("no manifest for job; plan must run first");
      const directives = await directivesFor(p.job); // the supervisor's accumulated instructions
      // A repair target is EDITED, not rewritten: deps.repairFile returns find→replace edits applied with
      // update_artifact's exact-once semantics, plus the root cause the user asked to be told.
      if (p.repair || st.repair) {
        const r = await deps.repairFile(p.job, st, p.path, ctx.deadline);
        // The root cause is recorded on the JOB, not only in this step's result: the final report is
        // assembled after the last round, long after this row's result would have to be re-queried and
        // matched by payload.
        const fresh = await getJobState(p.job);
        if (fresh?.repair && r.rootCause) {
          await putJobState(p.job, { ...fresh, repair: { ...fresh.repair, rootCauses: { ...(fresh.repair.rootCauses ?? {}), [p.path]: String(r.rootCause).slice(0, 600) } } });
        }
        return { path: p.path, issues: r.issues, truncated: r.truncated, changed: r.changed, rootCause: String(r.rootCause ?? "").slice(0, 600) };
      }
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
    run: async (p: { job: string; round?: number }, ctx) => {
      const round = Number(p.round ?? 0);
      const st = await getJobState(p.job);
      const lf = st?.artifactId ? await listFiles(st.artifactId) : null;
      if (!lf) {
        await putJobState(p.job, { ...st, finishedAt: Date.now(), complete: false, issues: ["artifact missing"] });
        return { ok: false, complete: false, issues: ["artifact missing"] };
      }
      const planned: string[] = await plannedPathsFor(p.job, st);
      // Heal before judging. A missing type="module" or a missing export is a blank page, and it is
      // cheaper to fix here than to spend another model call (or report the build complete-but-broken).
      const healed = st.session && st.artifactId ? await healAndSave(String(st.session), Number(st.artifactId)) : { changes: [], issues: [] };
      const lf2 = healed.changes.length ? await listFiles(st.artifactId) : lf;
      const files = lf2?.files ?? lf.files;
      const have = new Map(files.filter((f) => isBuilt(f.content)).map((f) => [f.path, f.content]));
      // "Present but empty" counts as missing. A zero-byte file satisfies a filename check and nothing else.
      const missing = planned.filter((path) => !have.has(path));
      const issues = healed.issues.length || healed.changes.length ? healed.issues : lintArtifact(files);

      // ── A REPAIR IS JUDGED BY ITS GOAL, NOT BY ITS FILE LIST ────────────────────────────────────────
      // "Every planned file exists" was the whole acceptance test, and for a repair it was already true
      // before the repair started — which is how a job that changed nothing reported 12/12 and drained.
      // For a repair, `verify` does the mechanical healing, records the deterministic verdict, and hands
      // the loop to goalcheck, which decides whether another round is warranted. Nothing here may declare
      // a repair finished.
      if (st?.repair) {
        const verdict = evaluateRepair(st, files, issues);
        const roundNow = Math.max(0, Number(st.repair.round ?? round));
        await putJobState(p.job, {
          ...st, complete: missing.length === 0, missing, issues, healed: healed.changes,
          repair: {
            ...st.repair, ...verdict.state, round: roundNow,
            failed: [...new Set([...(st.repair.failed ?? []), ...verdict.unresolved].map(String))],
          },
        });
        await enqueue(p.job, [{ kind: "goalcheck", payload: { job: p.job, round: roundNow }, seq: 99.5, needs: ctx.step.id, priority: 3, dedupe: `goalcheck:${st.repair.runKey ?? "0:0"}:${roundNow}` }]);
        return { repair: true, ok: verdict.resolved, complete: missing.length === 0, round: roundNow, ...verdict.report };
      }

      const broken = [...new Set(issues.map(issuePath).filter((path) => path && have.has(path) && planned.includes(path)))];
      // `filesComplete` = every planned file exists. `ok` also requires a clean lint. A build that
      // produced every file and still throws at parse time used to report itself complete — that is
      // how "the app built" and "the app is a blank page" became the same status.
      const filesComplete = planned.length > 0 && missing.length === 0;
      const toRebuild = [...new Set([...missing, ...broken])];

      // A JOB MAY NOT CREATE UNBOUNDED WORK. verify re-enqueues a build per missing/broken file for 3 rounds,
      // and the supervisor adds up to 4 per pass for 8 passes — neither knew about the other, so the
      // only ceiling was the scheduler's global queue-depth refusal, which protects the QUEUE, not this
      // job. A job that has spent its budget is not one more task away from working.
      const spent = await stepCount(p.job);
      const budget = jobStepBudget(planned.length);
      if (toRebuild.length && spent >= budget) {
        await putJobState(p.job, { ...st, finishedAt: Date.now(), complete: filesComplete, missing, issues, healed: healed.changes });
        return { ok: false, complete: filesComplete, planned: planned.length, built: planned.length - missing.length, missing, issues, healed: healed.changes, stoppedBy: `this job has run ${spent} tasks against a budget of ${budget}; ${toRebuild.length} file(s) still need work` };
      }
      if (toRebuild.length && round < VERIFY_ROUNDS) {
        const ids = await enqueue(p.job, toRebuild.map((path, i) => ({
          kind: "build",
          payload: { job: p.job, path },
          seq: 200 + round * 100 + i,
          // Round-scoped dedupe: the original build:<path> key is already taken by the attempt that failed.
          dedupe: `rebuild:${round}:${path}`,
        })));
        const last = ids[ids.length - 1];
        await enqueue(p.job, [{ kind: "verify", payload: { job: p.job, round: round + 1 }, seq: 299 + round * 100, needs: last, gate: "build" }]);
        await putJobState(p.job, { ...st, complete: false, missing, issues, healed: healed.changes });
        return { ok: false, complete: false, planned: planned.length, built: planned.length - missing.length, missing, issues, rebuilding: toRebuild.length, round, healed: healed.changes };
      }

      await putJobState(p.job, { ...st, finishedAt: Date.now(), complete: filesComplete, missing, issues, healed: healed.changes });
      return {
        ok: filesComplete && issues.length === 0,
        complete: filesComplete,
        planned: planned.length,
        built: planned.length - missing.length,
        missing,
        issues,
        healed: healed.changes,
        ...(toRebuild.length ? { gaveUpAfterRounds: round } : {}),
      };
    },
  });

  /*  goalcheck — the loop's only terminal authority. It asks a question no other step asks: is the
   *  reported failure gone, and did anything actually change to get there?
   *
   *  Three outcomes, and all three are explicit:
   *    resolved    every target exists, is lint-clean, and changed during this round.
   *    stopped     the user pressed stop. Nothing further is enqueued, ever.
   *    another round  the goal is unmet and rounds remain — this is what "keep working until it is fixed"
   *                means in a system whose work must fit inside 60-second invocations. The round is not a
   *                retry of the same instruction: `diagnose` re-derives the findings and tells the repair
   *                that the previous attempt left the file unchanged, so the next model call has new
   *                information instead of the same prompt it already failed to act on.
   *
   *  Bounded by MAX_REPAIR_ROUNDS and the job budget, so "until it is fixed" cannot mean "forever". */
  registerHandler("goalcheck", {
    maxMs: stepMs("goalcheck"),
    run: async (p: { job: string; round?: number }) => {
      const st = await getJobState(p.job);
      if (!st?.repair) return { skipped: "not a repair job" };
      const id = Number(st.artifactId);
      // Heal before judging, exactly as verify does for a build: a repair that introduced a missing export
      // or left TypeScript in a .js file is judged on the file as it will actually be SERVED, not on the
      // bytes the model returned. Healing counts as a real change, because it is one.
      if (Number.isInteger(id) && st.session) await healAndSave(String(st.session), id).catch(() => null);
      const lf = Number.isInteger(id) ? await listFiles(id) : null;
      const files = lf?.files ?? [];
      const round = Math.max(0, Number(st.repair.round ?? p.round ?? 0));
      const verdict = evaluateRepair(st, files, lf ? lintArtifact(files) : []);
      const rootCauses = verdict.report.rootCauses as string[];
      const whatWasWrong = rootCauses.length ? rootCauses.join("\n") : String(st.repair.errors ?? "").slice(0, 300);
      const goal = String(st.repair.goal ?? "");

      const finish = async (outcome: "resolved" | "stopped" | "exhausted" | "budget", extra: Record<string, unknown> = {}) => {
        const unresolved = verdict.unresolved;
        await putJobState(p.job, {
          ...st, finishedAt: Date.now(), complete: outcome === "resolved",
          repair: {
            ...st.repair, ...verdict.state, resolved: outcome === "resolved", outcome, whatWasWrong, round,
            failed: [...new Set([...(st.repair.failed ?? []), ...unresolved].map(String))],
          },
          // The card renders `conform`; for a repair the verdict IS the conformance answer ("is this
          // what was asked for" = "is the reported failure gone"), so it is written in the same shape
          // rather than teaching every reader a second one.
          conform: { matches: outcome === "resolved", built: goal, mismatches: outcome === "resolved" ? [] : unresolved, extra: [], repair: true, outcome, whatWasWrong, ts: Date.now() },
        });
        return { repair: true, outcome, round, goal, unresolved, whatWasWrong, ...extra };
      };

      if (st.repair.stopped) return await finish("stopped", { stopped: true });
      if (verdict.resolved) return await finish("resolved", { resolved: true });
      // A round that is allowed to run must also be a round that CAN run: the same budget guard verify
      // uses, so a job that has spent its ceiling reports failure instead of enqueueing work nobody will
      // ever pay for.
      const spent = await stepCountSince(p.job, Number(st.repair.firstStepId ?? 0));
      const budget = jobStepBudget(Math.max(1, (st.repair.targets ?? []).length)) + 4 * MAX_REPAIR_ROUNDS;
      const attempts = round + 1; // round is 0-based; this is "how many tries including this one"
      const maxRounds = Number(st.repair.maxRounds ?? MAX_REPAIR_ROUNDS);
      if (attempts >= maxRounds || spent >= budget) {
        const why = attempts >= maxRounds
          ? `the repair ran ${attempts} round(s) without resolving the reported failure`
          : `this job has run ${spent} tasks against a budget of ${budget}`;
        await enqueue(p.job, [{ kind: "report_blocked", payload: { job: p.job, reason: why, unresolved: verdict.unresolved }, priority: 10, dedupe: `repair-exhausted:${st.repair.runKey ?? p.job}` }]);
        return await finish("budget", { exhausted: true, why });
      }
      // A STOP THAT ARRIVED WHILE THIS STEP WAS RUNNING STILL STOPS THE JOB. `stopJob` marks the queue
      // terminal, but a goalcheck that was already executing reads its snapshot of state at entry — so the
      // intent is re-read from the database here, at the only moment that matters: before creating work.
      const fresh = await getJobState(p.job);
      if (fresh?.repair?.stopped) {
        await putJobState(p.job, { ...fresh, repair: { ...fresh.repair, ...verdict.state, resolved: false, outcome: "stopped" } });
        return { repair: true, outcome: "stopped", round, unresolved: verdict.unresolved, stopped: true };
      }
      // NEXT ROUND: re-diagnose (which re-reads the ask and the CURRENT files, and records the new
      // round-start fingerprints), then a fresh goalcheck gated on the builds that diagnose creates.
      const runKey = String(st.repair.runKey ?? "0:0");
      const [diagId] = await enqueue(p.job, [{ kind: "diagnose", payload: { job: p.job, round: round + 1 }, seq: 300 + round * 50, priority: 4, dedupe: `repair-round:${runKey}:${round + 1}` }]);
      await enqueue(p.job, [{ kind: "goalcheck", payload: { job: p.job, round: round + 1 }, seq: 399 + round * 50, needs: diagId, gate: "build", priority: 3, dedupe: `goalcheck:${runKey}:${round + 1}` }]);
      await putJobState(p.job, {
        ...st,
        repair: {
          ...st.repair, ...verdict.state, round: round + 1, why: verdict.state.why,
          failed: [...new Set([...(st.repair.failed ?? []), ...verdict.unresolved].map(String))],
        },
      });
      return { repair: true, outcome: "round", round: round + 1, unresolved: verdict.unresolved, why: verdict.state.why, goal };
    },
  });
}

/** THE DETERMINISTIC VERDICT ON A REPAIR ROUND.
 *
 *  Three ways a target can still be unfixed, and each is a fact read off the artifact rather than an
 *  opinion: it is missing/empty; the static lint still names it; or it is BYTE-IDENTICAL to how the round
 *  found it, which means the round did no work at all regardless of what the model said. The third check
 *  is the one that would have caught the reported run: three files "repaired", the queue drained, and
 *  render.js exactly as it was.
 *
 *  `rootCauses` come from the repair calls themselves, so the closing report can answer the user's actual
 *  question — "say what was wrong" — with the model's own words about the defect it removed. */
export function evaluateRepair(st: any, files: { path: string; content: string }[], issues: string[]) {
  const repair = st?.repair ?? {};
  const targets: string[] = (repair.targets ?? []).map(String).filter(Boolean);
  // WHAT THIS ROUND WAS ASKED TO FIX — which is not always every target: round 2+ skips files an earlier
  // round already repaired, and those must not be re-judged as "unchanged".
  const attempted: string[] = ((repair.roundTargets ?? repair.targets ?? []) as unknown[]).map(String).filter(Boolean);
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const roundStart: Record<string, string> = repair.roundStart ?? {};
  const lintBy = new Map<string, string[]>();
  for (const issue of issues) {
    const m = /^([^\s:]+):\s*(.+)$/.exec(String(issue ?? ""));
    if (!m) continue;
    const arr = lintBy.get(m[1]);
    if (arr) arr.push(m[2]); else lintBy.set(m[1], [m[2]]);
  }
  const unresolved: string[] = [];
  const why: Record<string, string> = {};
  for (const t of attempted) {
    const content = byPath.get(t);
    if (content === undefined || !content.trim()) { unresolved.push(t); why[t] = "the file is still missing or empty"; continue; }
    const lint = lintBy.get(t) ?? [];
    if (lint.length) { unresolved.push(t); why[t] = `static defects remain: ${lint[0]}`; continue; }
    if (roundStart[t] !== undefined && fingerprint(content) === roundStart[t]) {
      unresolved.push(t);
      why[t] = "this round left the file byte-identical, so the reported failure cannot have been fixed by it — take a different approach";
    }
  }
  const resolved = targets.length > 0 && attempted.length > 0 && unresolved.length === 0;
  const rootCauses = Object.entries(repair.rootCauses ?? {})
    .filter(([path]) => targets.includes(path))
    .map(([path, cause]) => `${path}: ${String(cause)}`)
    .slice(0, 8);
  const state = { unresolved, resolved, why, resolvedAt: resolved ? (repair.resolvedAt ?? Date.now()) : (repair.resolvedAt ?? null) };
  return {
    resolved, unresolved, state,
    report: { goal: String(repair.goal ?? ""), targets, unresolved, why, rootCauses, whatWasWrong: rootCauses.join("\n"), primary: repair.primary ?? targets[0] ?? null },
  };
}

/** STOP A JOB, SERVER-SIDE.
 *
 *  The client's stop button used to set a local flag on the polling loop and nothing else: the steps stayed
 *  in the queue, so the interval val kept running them after the tab was closed and the "stopped" repair
 *  kept spending. A stop that does not stop the work is worse than no stop button, because the user
 *  believes they have stopped it. This marks every unstarted step terminal, records the reason on the job,
 *  and is what the client now calls before it stops polling. A step already executing finishes (killing an
 *  isolate mid-write is how artifacts lose files); the goalcheck that follows it sees `stopped` and
 *  enqueues nothing further. */
export async function stopJob(job: string, reason = "stopped by the user"): Promise<{ job: string; stopped: number; repair: boolean }> {
  const msg = String(reason ?? "").slice(0, 200);
  const r = await run(sql`UPDATE step SET status='skipped', error=${msg}, lease_until=0, updated=${Date.now()} WHERE job = ${job} AND status IN ('ready','running')`);
  const st = await getJobState(job);
  if (st) {
    const stoppedAt = Date.now();
    await putJobState(job, st.repair
      ? { ...st, finishedAt: stoppedAt, complete: false, repair: { ...st.repair, stopped: true, stoppedAt, stopReason: msg, outcome: "stopped" },
          conform: { matches: false, built: String(st.repair.goal ?? ""), mismatches: (st.repair.unresolved ?? []).map(String), extra: [], repair: true, outcome: "stopped", whatWasWrong: st.repair.whatWasWrong ?? "", ts: stoppedAt } }
      : { ...st, stopped: true, stoppedAt, finishedAt: stoppedAt, complete: false });
  }
  return { job, stopped: r.ok ? Number((r.value as any)?.rowsAffected ?? 0) : 0, repair: !!st?.repair };
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
/** Tasks a job has spent SINCE a given step id.
 *
 *  A repair shares its job id with the build of the same artifact (same namespace, same progress card),
 *  so `stepCount(job)` counts the ORIGINAL BUILD's steps too: on a 12-file artifact the repair was born
 *  already over a 24-task budget and reported "could not fix it" after one round. The budget must measure
 *  what THIS repair has spent, not what the artifact cost to create. */
export async function stepCountSince(job: string, sinceId: number): Promise<number> {
  const r = await raw<{ n: number }>(sql`SELECT COUNT(*) AS n FROM step WHERE job = ${job} AND id >= ${sinceId}`);
  return r.ok ? Number((r.value[0] as any)?.n ?? 0) : 0;
}

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
  // A REPAIR'S PLAN IS ITS TARGETS. The synthetic repair manifest lists EVERY file in the artifact (the
  // builders need the full file list for context), so reading it as the plan made `complete` mean "every
  // file in the app exists" — a condition that was already true before the repair started. That is how a
  // job whose only job was to fix render.js reported 12/12 and drained without touching render.js.
  const targets: string[] = (st?.repair?.targets ?? []).map(String).filter(Boolean);
  if (targets.length) return [...new Set(targets)];
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
  // FOR A REPAIR, "BUILT" MEANS "KNOWN GOOD", NOT "THE FILE EXISTS". Every target of a repair already
  // exists — that is why it has a bug to fix — so counting existence reported 1/1 before anything had run,
  // and kept reporting it while the file was still broken. `failed` is the accumulated verdict.
  const repairTargets: string[] = (st?.repair?.targets ?? []).map(String).filter(Boolean);
  const repairFailed = new Set(((st?.repair?.failed ?? []) as unknown[]).map(String));
  const drained = (by.ready ?? 0) + (by.running ?? 0) === 0;
  // ── WHAT A REPAIR TELLS ITS DRIVER ────────────────────────────────────────────────────────────────
  // The client's polling loop needs to know the difference between "the queue drained" and "the work is
  // finished", and for a repair those are different questions (the reported run was drained, unchanged,
  // and still broken). `settled` is the one bit the loop stops on: resolved, stopped, exhausted, or — for
  // a build — simply drained. Everything else is detail for the card.
  const repair = st?.repair ?? null;
  const resolved = repair ? repair.resolved === true : null;
  const stopped = repair ? repair.stopped === true : st?.stopped === true;
  // 1-based, because it is displayed: `round` is 0-based internally (round 0 is the first attempt).
  const rounds = repair ? Number(repair.round ?? 0) + 1 : null;
  const maxRounds = repair ? Number(repair.maxRounds ?? MAX_REPAIR_ROUNDS) : null;
  const outcome = repair ? String(repair.outcome ?? (repair.resolved ? "resolved" : stopped ? "stopped" : drained ? "paused" : "working")) : null;
  const settled = stopped || (repair ? resolved === true || outcome === "exhausted" || outcome === "budget" : drained);
  return {
    job, by, files, artifactId: st?.artifactId ?? null, title: st?.title ?? "",
    done: drained,
    complete: drained && planned.length > 0 && missing.length === 0,
    plannedFiles: planned.length,
    builtFiles: repairTargets.length
      ? repairTargets.filter((t) => !repairFailed.has(t)).length
      : Math.max(0, planned.length - missing.length),
    missing,
    // Repair shape: the goal it is judged against, this round, and what is still broken.
    kind: repair ? "repair" : "build",
    goal: repair ? String(repair.goal ?? repair.errors ?? "") : String(st?.ask ?? "").slice(0, 300),
    rounds, maxRounds, resolved, stopped, outcome, settled,
    unresolved: repair ? (repair.unresolved ?? []) : [],
    // WHAT THIS REPAIR IS ABOUT. `files` lists every build step the JOB ever had — including the previous
    // build's steps, because a repair reuses the artifact's job — so the reply and the card must read the
    // repair's own targets, not every file that was ever built here.
    targets: repair ? (repair.targets ?? []) : [],
    roundTargets: repair ? (repair.roundTargets ?? []) : [],
    untouched: repair ? (repair.untouched ?? []) : [],
    primary: repair?.primary ?? null,
    whatWasWrong: repair ? String(repair.whatWasWrong ?? "") : "",
    tried: repair ? Object.keys(repair.rootCauses ?? {}) : [],
    failedSteps: (by.failed ?? 0) + (by.blocked ?? 0),
    // `complete` means every planned file exists. `conform` means the planned files were the right ones.
    // A build can be complete and wrong, and that combination is the whole reported complaint, so it is
    // reported separately rather than folded into one boolean that would have to lie about one of them.
    conform: st?.conform ?? null,
  };
}
