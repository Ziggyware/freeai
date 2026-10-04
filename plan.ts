// PLANS AND TASKS — the deterministic core.
//
// A plan in this system is a manifest: a list of files, each with exports it promises and imports it
// needs. Tasks are the scheduler's steps. Everything here is about the relationship between the two,
// and all of it is mechanism rather than prompting — a plan that cannot build is rejected before any
// task is created, and the tasks that are created are ordered by the plan's own dependency graph.
//
// The premise: a multi-file app written by N independent calls fails at the SEAMS. Every file passes
// its own lint and the app is still broken, because file A was written at the same moment as file B
// and had to invent B's API. Ordering is not an optimisation here; it is the difference between
// agreeing by construction and agreeing by luck.

export type PlanFile = { path: string; purpose?: string; exports?: string[]; imports?: string[]; notes?: string };
export type Plan = { title?: string; files: PlanFile[]; features?: unknown[]; visual?: string; shared?: string; ask?: string };

const norm = (p: unknown) => String(p ?? "").replace(/^\.\//, "").trim();
const isCode = (p: string) => /\.m?jsx?$/.test(p);
const isEntry = (p: string) => /^index\.html?$/i.test(p);

/** Files the plan says this file imports, restricted to files the plan actually lists. */
export function importsOf(plan: Plan, path: string): string[] {
  const known = new Set((plan.files ?? []).map((f) => norm(f.path)));
  const f = (plan.files ?? []).find((x) => norm(x.path) === norm(path));
  return ([] as unknown[]).concat(f?.imports ?? [])
    .map(norm)
    .filter((x) => x && x !== norm(path) && known.has(x));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. A PLAN THAT CANNOT BUILD IS REJECTED BEFORE ANY TASK EXISTS
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Everything wrong with this plan, as instructions the planner can act on.
 *
 *  planApp accepted ANY manifest with at least one file. A plan that imports a file it never lists, or
 *  names the same path twice, or has no entry point, is not a plan — but it was turned into a dozen
 *  build tasks anyway, each of which then failed or invented something, and the failure surfaced twelve
 *  steps later as a lint complaint about a file nobody could fix. Cheapest possible moment to catch it
 *  is before the fan-out, against the plan itself, with no model call. */
export function validatePlan(plan: Plan): string[] {
  const out: string[] = [];
  const files = (plan.files ?? []).filter((f) => f && typeof f.path === "string");
  if (!files.length) return ["the plan lists no files at all"];

  const paths = files.map((f) => norm(f.path));
  const known = new Set(paths);

  const dupes = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
  if (dupes.length) out.push(`the plan lists ${dupes.join(", ")} more than once — every path must appear exactly once, because two builders writing the same file overwrite each other`);

  const bad = paths.filter((p) => !p || p.startsWith("/") || p.includes("..") || /^[a-z]+:/i.test(p));
  if (bad.length) out.push(`these paths are not writable relative paths: ${bad.join(", ")} — use plain paths like main.js or src/store.js`);

  if (!paths.some(isEntry)) out.push("the plan has no index.html — the artifact has no entry point and nothing will render");

  for (const f of files) {
    const from = norm(f.path);
    for (const imp of ([] as unknown[]).concat(f.imports ?? []).map(norm)) {
      if (!imp || imp === from) continue;
      if (!known.has(imp)) out.push(`${from} imports "${imp}", which the plan does not list — either add that file to the plan or stop importing it`);
    }
  }

  for (const cyc of planCycles(plan)) out.push(cyc);


  // A plan nobody can finish is a plan that will report itself incomplete. Better to say so now.
  if (files.length > 10) out.push(`the plan has ${files.length} files, which is more than one build can finish reliably — merge related modules until it is 8 or fewer`);
  return out.slice(0, 10);
}

/** Things worth SAYING about a plan that are not reasons to refuse it.
 *
 *  Kept separate on purpose. The first version of validatePlan treated "this module declares no exports
 *  and no imports" as a blocking defect, which rejected entirely buildable plans — a planner may list a
 *  side-effecting entry script, or simply not bother declaring a contract it considers obvious — and a
 *  false positive here does not degrade a build, it refuses to start one. Blocking is reserved for plans
 *  that CANNOT build; everything else is advice handed to the builder. */
export function planWarnings(plan: Plan): string[] {
  const out: string[] = [];
  for (const f of plan.files ?? []) {
    const from = norm(f.path);
    if (isCode(from) && !isEntry(from) && !(f.exports ?? []).length && importsOf(plan, from).length === 0) {
      out.push(`${from} declares no exports and no imports — if other files are meant to use it, say what it exports`);
    }
  }
  return out.slice(0, 6);
}

/** Import cycles, as design defects. A cycle is not fatal to building (the graph is flattened) but it
 *  is always a mistake, and naming it is how it gets fixed rather than inherited. */
export function planCycles(plan: Plan): string[] {
  const edges = new Map<string, string[]>();
  for (const f of plan.files ?? []) edges.set(norm(f.path), importsOf(plan, norm(f.path)));
  const out: string[] = [];
  for (const start of edges.keys()) {
    const seen = [start];
    let cur: string | undefined = (edges.get(start) ?? [])[0];
    while (cur && seen.length < 12) {
      if (cur === start) { out.push(`import cycle: ${[...seen, cur].join(" -> ")} — move the shared part into its own module`); break; }
      if (seen.includes(cur)) break;
      seen.push(cur);
      cur = (edges.get(cur) ?? [])[0];
    }
  }
  return [...new Set(out)].slice(0, 3);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. THE PLAN'S DEPENDENCY GRAPH DECIDES THE ORDER OF THE TASKS
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Depth of each file: 0 for files that import nothing in the project, 1 for files importing only
 *  depth-0 files, and so on. index.html is forced last — it wires up whatever actually got built.
 *  A cycle is broken by treating the revisited node as a root, because refusing to build is worse. */
export function planDepths(plan: Plan): Map<string, number> {
  const known = (plan.files ?? []).map((f) => norm(f.path)).filter(Boolean);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (path: string): number => {
    if (depth.has(path)) return depth.get(path)!;
    if (visiting.has(path)) return 0;
    visiting.add(path);
    const deps = importsOf(plan, path);
    const d = deps.length ? Math.max(...deps.map(walk)) + 1 : 0;
    visiting.delete(path);
    depth.set(path, d);
    return d;
  };
  for (const p of known) walk(p);
  const maxDepth = Math.max(0, ...depth.values());
  for (const p of known) if (isEntry(p)) depth.set(p, maxDepth + 1);
  return depth;
}

/** Scheduler priority for a file's build task. The scheduler ranks ready steps by priority, and nothing
 *  ever set it — so a twelve-file build ran its README with the same urgency as its state store.
 *
 *  Shallower is more urgent, because everything above it is blocked on it. Within a depth, a file other
 *  files import outranks one nobody imports: that is the difference between unblocking four builders and
 *  unblocking none. Documentation sinks to the bottom; it is the one file that can be written from the
 *  plan alone and is worth nothing until the code exists. */
export function planPriority(plan: Plan, path: string): number {
  const p = norm(path);
  const depth = planDepths(plan).get(p) ?? 0;
  const dependents = (plan.files ?? []).filter((f) => importsOf(plan, norm(f.path)).includes(p)).length;
  if (/\.md$/i.test(p)) return -5;
  return 100 - depth * 10 + Math.min(dependents, 8);
}

/** The plan's files in build order, with the depth and priority each task should carry. */
export function planOrder(plan: Plan): { path: string; depth: number; priority: number; needs: string[] }[] {
  const depths = planDepths(plan);
  return [...depths.entries()]
    .map(([path, depth]) => ({ path, depth, priority: planPriority(plan, path), needs: importsOf(plan, path) }))
    .sort((a, b) => a.depth - b.depth || b.priority - a.priority || a.path.localeCompare(b.path));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. A PLAN THAT CHANGES SHOULD NOT REBUILD WHAT DID NOT CHANGE
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/** What differs between the plan that was built and the plan now wanted.
 *
 *  Amending an ask re-planned from scratch and rebuilt every file, discarding work that was already
 *  correct and costing a full build for a one-file change. A file is "changed" when its contract moves —
 *  its purpose, its exports or its imports — because those are what a builder is written against;
 *  cosmetic note edits are not a reason to rewrite a working file. */
export function diffPlans(before: Plan | null | undefined, after: Plan): {
  added: string[]; removed: string[]; changed: string[]; unchanged: string[];
} {
  const key = (f: PlanFile) => JSON.stringify([
    String(f.purpose ?? "").trim(),
    ([] as unknown[]).concat(f.exports ?? []).map(String).sort(),
    ([] as unknown[]).concat(f.imports ?? []).map(norm).sort(),
  ]);
  const b = new Map((before?.files ?? []).map((f) => [norm(f.path), key(f)]));
  const a = new Map((after.files ?? []).map((f) => [norm(f.path), key(f)]));
  const added: string[] = [], changed: string[] = [], unchanged: string[] = [];
  for (const [path, sig] of a) {
    if (!b.has(path)) added.push(path);
    else if (b.get(path) !== sig) changed.push(path);
    else unchanged.push(path);
  }
  return { added, removed: [...b.keys()].filter((p) => !a.has(p)), changed, unchanged };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. A JOB MAY NOT CREATE UNBOUNDED WORK
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The most tasks one job may ever hold.
 *
 *  The supervisor may add 4 steps per pass for 8 passes, and verify re-enqueues a build per missing file
 *  for 3 rounds — none of which knew about the others, so a 20-file plan had no ceiling at all beyond
 *  the scheduler's global queue-depth refusal, which is a different thing protecting a different system.
 *  A job that has spent this many tasks is not one more task away from working. */
export function jobStepBudget(plannedFiles: number): number {
  return Math.max(24, Math.ceil(plannedFiles * 2.5) + 12);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. TASKS, AS SOMETHING A PERSON CAN READ
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type TaskRow = { id: number; kind: string; status: string; payload: string; needs: number | null; gate: string | null; priority: number; created: number; updated: number; started?: number; error: string | null };
export type Task = {
  id: number; kind: string; label: string; status: string; needs: number[]; gate: string | null;
  priority: number; ms: number | null; error: string | null; blockedBy: string | null;
};

/** The job's step graph as a task list: what each task is, what it waits on, and — when it is waiting —
 *  WHY, in words. "blocked" and "ready but not running" look identical in a status column and have
 *  completely different causes; a task view that cannot tell them apart is decoration. */
export function taskGraph(rows: TaskRow[]): Task[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unfinishedOfKind = (kind: string) => rows.filter((r) => r.kind === kind && !["done", "failed", "blocked", "skipped"].includes(r.status));
  return rows.map((r) => {
    let path = "";
    try { path = String(JSON.parse(r.payload || "{}").path ?? ""); } catch { /* payload is opaque here */ }
    const parent = r.needs ? byId.get(r.needs) : undefined;
    let blockedBy: string | null = null;
    if (r.status === "ready" || r.status === "blocked") {
      if (parent && parent.status !== "done") blockedBy = `waiting for #${parent.id} ${parent.kind}${parent.status === "failed" ? " (which failed)" : ""}`;
      else if (r.gate) {
        const open = unfinishedOfKind(r.gate);
        if (open.length) blockedBy = `waiting for ${open.length} ${r.gate} task${open.length === 1 ? "" : "s"}`;
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      label: path ? `${r.kind}: ${path}` : r.kind,
      status: r.status,
      needs: r.needs ? [r.needs] : [],
      gate: r.gate,
      priority: r.priority,
      ms: r.started && r.updated && r.status === "done" ? Math.max(0, r.updated - r.started) : null,
      error: r.error,
      blockedBy,
    };
  });
}

/** How long each kind of task ACTUALLY takes, so the declared budgets can be checked against reality
 *  instead of guessed. A kind whose p95 approaches its declared maxMs is one slow day from timing out. */
export function taskDurations(tasks: Task[]): { kind: string; n: number; p50: number; p95: number; max: number }[] {
  const by = new Map<string, number[]>();
  for (const t of tasks) if (typeof t.ms === "number") (by.get(t.kind) ?? by.set(t.kind, []).get(t.kind)!).push(t.ms);
  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  return [...by.entries()].map(([kind, xs]) => {
    xs.sort((a, b) => a - b);
    return { kind, n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs[xs.length - 1] };
  }).sort((a, b) => b.p95 - a.p95);
}
