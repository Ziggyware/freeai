// THE WIRE. app-build.ts declares the scheduled build pipeline and app-swarm.ts implements the three
// operations it needs, but nothing connected them - registerBuildHandlers() had no caller, so a job that
// enqueued a "plan" or "build" step would have failed with "no handler for kind". The whole scheduled
// pipeline was dead code while the live path still tried to build an app in one response.
//
// This file is the one-directional seam: app.tsx owns PassMeter and the session helpers, app-swarm.ts owns
// the model calls, app-build.ts owns the step graph. Passing the dependencies through here instead of
// importing app.tsx keeps the import graph acyclic.
import { T } from "./timing.ts";
import { buildProgress, cancelJob, evaluateRepair, getJobState, jobIdFor, registerBuildHandlers, startBuild, startRepair } from "./app-build.ts";
import { jobStatus, tick } from "./scheduler.ts";
import { buildFileOnce, conformApp, designApp, PLACEHOLDER_MARK, planApp, repairFileOnce, type SwarmDeps } from "./app-swarm.ts";
import { lintArtifact, listFiles, missingRefs, saveMany } from "./artifacts.ts";
import { healAndSave, issuePath } from "./heal.ts";
import { importsOf } from "./plan.ts";
import { isStructuralRepair, localImports, parseRepairAsk, pickRepairTargets, repairGoal, unchanged } from "./repair.ts";

let wired = false;

/** Called once at module load by app.tsx. Idempotent: registering a handler twice would silently shadow. */
export function wireBuild(d: SwarmDeps): void {
  if (wired) return;
  wired = true;
  registerBuildHandlers({
    // A repair is not judged against the ask the way a build is: "fix render.js:27" is not a description of
    // an app, so a conformance prompt that asks "is this artifact the thing that was asked for" answers a
    // question nobody asked. For a repair the same JSON shape is filled from the deterministic verdict.
    conform: async (_job, st) => {
      if (st.repair) {
        const lf = await listFiles(Number(st.artifactId));
        const v = evaluateRepair(st, lf?.files ?? [], lf ? lintArtifact(lf.files) : []);
        return { matches: v.resolved, built: String(st.repair.goal ?? ""), mismatches: v.unresolved, extra: [] };
      }
      return conformApp(String(st.ask ?? ""), Number(st.artifactId), st.settings ?? {}, d);
    },

    design: async (_job, st) => designApp(String(st.ask ?? ""), String(st.session ?? "default"), st.settings ?? {}, d),

    plan: async (_job, st) => {
      // Carry BOTH the design and any artifact this job already owns: the first makes the file list
      // realise the design, the second stops a retry from creating a second artifact.
      const r = await planApp(String(st.ask ?? ""), String(st.session ?? "default"), st.settings ?? {}, d, {
        design: typeof st.design === "string" ? st.design : undefined,
        artifactId: st.artifactId ?? null,
      });
      if (!r.artifactId) throw Object.assign(new Error("planner produced no artifact shell"), { status: 503, retryable: true });
      return { manifest: r.manifest, artifactId: r.artifactId };
    },

    // REPAIR one file: the smallest correct edit over the file that exists, plus its root cause.
    repairFile: async (_job, st, path, deadline) => {
      const session = String(st.session ?? "default");
      const id = Number(st.artifactId);
      const lf = await listFiles(id);
      const cur = lf?.files.find((f) => f.path === path);
      const findings: string[] = (st.repair?.findings ?? {})[path] ?? [];
      // Round 2+ carries the previous round's verdict into the next prompt. Without this, a second round
      // is the same call with the same text, which is a retry rather than a new attempt.
      const priorWhy = st.repair?.why?.[path];
      const brief = priorWhy ? [...findings, `the previous repair round did not fix it: ${priorWhy}`] : findings;
      const r = await repairFileOnce(session, id, st.manifest ?? { files: [] }, path, st.settings ?? {}, d, {
        goal: String(st.repair?.goal ?? st.ask ?? ""),
        findings: brief,
        directives: dependencyBrief(cur?.content ?? "", (lf?.files ?? []).map((f) => f.path), path, lf?.files ?? []),
        current: cur?.content ?? "",
        deadline,
      });
      return { issues: r.issues, truncated: r.truncated, changed: r.changed, rootCause: r.rootCause };
    },

    buildFile: async (_job, st, path, directives, deadline) => {
      // A repair that reached THIS path is a routing bug, and it is routed the safe way rather than
      // rewritten: the surgical protocol is the only thing permitted to touch a file a user asked to fix.
      // (It used to be reachable, and "rewrite this file from its purpose line" on a file that is 90 %
      // correct is how a repair turns into a regression — the reported run rewrote render.js and left the
      // constructor error in it.)
      if (st.repair) {
        const lf = await listFiles(Number(st.artifactId));
        const cur = lf?.files.find((f) => f.path === path);
        const r = await repairFileOnce(String(st.session ?? "default"), Number(st.artifactId), st.manifest ?? { files: [] }, path, st.settings ?? {}, d, {
          goal: String(st.repair.goal ?? st.ask ?? ""),
          findings: (st.repair.findings ?? {})[path] ?? [],
          directives: [...dependencyBrief(cur?.content ?? "", (lf?.files ?? []).map((f) => f.path), path, lf?.files ?? []), ...directives],
          current: cur?.content ?? "",
          deadline,
        });
        return { issues: r.issues ?? [], truncated: !!r.truncated };
      }
      const repairPre: string[] = [];
      // THE FILES THIS ONE IMPORTS, AS THEY ACTUALLY ARE. Ordering the tasks by the dependency graph is
      // only half the win: it guarantees the dependency EXISTS when this builder runs, and this hands it
      // over verbatim so the importer matches the real signatures instead of the plan's summary of them.
      const deps = importsOf(st.manifest ?? { files: [] }, path);
      if (deps.length) {
        const lf2 = await listFiles(Number(st.artifactId));
        const shown = (lf2?.files ?? []).filter((f) => deps.includes(f.path) && f.content.trim() && !f.content.includes(PLACEHOLDER_MARK));
        if (shown.length) {
          repairPre.push(
            "THE FILES YOU IMPORT, AS THEY WERE ACTUALLY WRITTEN. Match these exports and signatures exactly — they already exist and other files already use them:\n" +
            shown.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 6_000)}`).join("\n\n"),
          );
        }
      }
      // Every builder is handed the design document as a directive, so no file has to infer the domain.
      const withDesign = typeof st.design === "string" && st.design
        ? [...repairPre, "The binding DESIGN DOCUMENT for this application follows. Implement your file against it exactly; do not reinterpret the domain, the names, or the units:", st.design, ...directives]
        : [...repairPre, ...directives];
      // The ask rides ON the manifest object rather than through another parameter: planApp already writes
      // it into the saved manifest.json, so this is the same field the artifact ships with.
      const manifestWithAsk = { ...(st.manifest ?? {}), ask: st.manifest?.ask ?? st.ask ?? "" };
      const lintForPath = ([] as string[]).concat(st.issues ?? []).filter((i) => issuePath(String(i)) === path);
      const withLint = lintForPath.length
        ? [...withDesign, "LINT DEFECTS to fix in this file — the previous write of it did not run:\n" + lintForPath.map((x) => "- " + x).join("\n")]
        : withDesign;
      const r = await buildFileOnce(String(st.session ?? "default"), Number(st.artifactId), manifestWithAsk, path, st.settings ?? {}, d, withLint);
      return { issues: r.issues ?? [], truncated: !!r.truncated };
    },

    // Integration is a REPAIR pass, not another generation pass: by the time it runs every file exists, so
    // the only thing left worth doing is fixing what the cross-file lint can actually see. When the lint is
    // clean this writes nothing at all - an integration step that always rewrites files would undo good work
    // on every run.
    integrate: async (_job, st, issues) => {
      const id = Number(st.artifactId);
      const session = String(st.session ?? "default");
      const lf = await listFiles(id);
      if (!lf) throw new Error("artifact vanished before integration");
      const index = lf.files.find((f) => /^index\.html?$/i.test(f.path));
      if (index && index.content.includes(PLACEHOLDER_MARK)) {
        // The plan-time placeholder shell is still in place, which means no builder ever wrote index.html.
        // Leaving it would ship a page that says "building 8 files..." forever.
        return { repaired: false, note: "index.html is still the plan-time placeholder", issues };
      }
      // MECHANICAL FIRST. type="module", missing exports, unlinked CSS, TypeScript-in-.js — none of
      // those need a model, and asking the model to "fix" them by rewriting index.html (the old
      // behaviour) left the actual broken files untouched.
      const healed = await healAndSave(session, id);
      // FOR A REPAIR, INTEGRATION ENDS HERE. The model-driven pass below rebuilds the file the lint blames,
      // with the generic builder — which on a repair job means rewriting a file the user asked to have
      // EDITED, undoing the surgical protocol and possibly the fix itself. Mechanical healing is safe and
      // stays; anything more is goalcheck's decision, made against the reported failure rather than the lint.
      if (st.repair) {
        return { repaired: healed.changes.length > 0, mechanical: healed.changes, remaining: healed.issues, repair: true };
      }
      if (!healed.issues.length) {
        return { repaired: healed.changes.length > 0, mechanical: healed.changes, remaining: [], files: lf.files.length };
      }
      // Rebuild the file the remaining issues actually name, not whichever file happens to be the entry.
      const counts = new Map<string, number>();
      for (const iss of healed.issues) {
        const p = issuePath(iss);
        if (!p) continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      const worstPath = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        ?? index?.path
        ?? lf.files[0].path;
      const inManifest = (st.manifest?.files ?? []).some((f: any) => f.path === worstPath);
      if (!inManifest) {
        return { repaired: healed.changes.length > 0, mechanical: healed.changes, remaining: healed.issues, note: `${worstPath} has issues but is not in the manifest, so it cannot be rebuilt here` };
      }
      const mine = healed.issues.filter((i) => issuePath(i) === worstPath).slice(0, 12);
      const r = await buildFileOnce(session, id, st.manifest, worstPath, st.settings ?? {}, d,
        ["Integration repair. Fix exactly these defects in THIS file and change nothing else:", ...mine]);
      const after = await healAndSave(session, id);
      return { repaired: !!r.written || after.changes.length > 0, mechanical: [...healed.changes, ...after.changes], fixed: worstPath, remaining: after.issues };
    },
  });
}

export { saveMany };


/** Does this ask want a MULTI-FILE APP BUILT, as opposed to a question, an edit, or a chat turn?
 *
 *  Deliberately conservative. A false positive hijacks an ordinary conversation into a build, which is
 *  far worse than a false negative - the user can always say "/build ..." to force it. So it requires an
 *  explicit construction verb AND an artifact noun, and it refuses when the turn is clearly an edit or is
 *  already focused on an existing artifact. */
export function looksLikeAppBuild(text: string, hasArtifactFocus: boolean): boolean {
  const t = String(text ?? "").trim();
  if (/^\/build\b/i.test(t)) return true;             // explicit override always wins
  if (hasArtifactFocus) return false;                  // editing something that already exists
  if (t.length < 12) return false;
  if (/\b(fix|update|change|edit|refactor|rename|debug|explain|why|how do|what is|review)\b/i.test(t)) return false;
  const verb = /\b(build|create|make|write|generate|scaffold|implement)\b/i.test(t);
  // Explicit visual-artifact requests are builds too. Without these nouns, "create a 3D holographic star
  // field" falls into the one-shot chat loop instead of the durable design → plan → one-file steps.
  const noun = /\b(app|application|game|website|web site|site|dashboard|editor|tracker|tool|clone|simulator|visuali[sz]\w*|visualization|scene|star\s*field|shader|holograph\w*|particle\s*system|generative\s*art|visual\s*effect|animation|graphic|illustration|calculator|todo(?:s| list)?|page|widget|prototype|player|ide|workbench|kanban|timer|clock|paint|chat)\b/i.test(t);
  return verb && noun;
}

/** Does this ask want an EXISTING artifact REPAIRED across files?
 *
 *  The complement of looksLikeAppBuild, and the case that kept dying inline: "look at the errors and
 *  finish the app files" is not a build (there is nothing to plan - the files are already there) and it
 *  is not a one-line edit either. It is a multi-file repair, which is a step graph.
 *
 *  Requires an artifact to repair, so it can never hijack a conversation: either the workbench has one
 *  focused, or the ask names one as #<id>. `/fix` is the explicit override. */
export function looksLikeRepair(text: string, hasArtifactFocus: boolean): boolean {
  const t = String(text ?? "").trim();
  if (/^\/fix\b/i.test(t)) return true;
  if (!hasArtifactFocus && !/#\d+\b/.test(t)) return false;
  if (t.length < 10) return false;
  // An explicit repair verb, or evidence pasted from a console. "update", "add", "change" and "improve"
  // are deliberately absent: those are ordinary edits and belong in the inline loop.
  return /\b(fix|repair|broken|finish|unfinished|resolve|console|stack ?trace|traceback|404|not found|is not defined|syntax ?error|failed to load|cannot (?:read|find|use))\b/i.test(t)
    || /\berrors?\b/i.test(t);
}

/** The artifact a repair is about: an id the user TYPED, else the focused one.
 *
 *  The explicit mention wins. It used to be the other way round (focus first), so pasting
 *  "fix #22 (render.js:27)" while artifact #17 was open in the workbench repaired #17 - the wrong file,
 *  which is exactly what "it must work on the right files" is about. A typed id is intent; focus is
 *  context. */
function repairTargetId(text: string, settings: any): number | null {
  const m = /#(\d+)\b/.exec(String(text ?? ""));
  const n = m ? Number(m[1]) : NaN;
  if (Number.isInteger(n) && n > 0) return n;
  const focus = Number(settings?.focus?.id);
  return Number.isInteger(focus) && focus > 0 ? focus : null;
}

export type ScheduleDeps = SwarmDeps & {
  addMsg: (role: string, content: string, a: unknown, session: string, meta: unknown) => Promise<unknown>;
};

/** THE TURN-LEVEL WIRING FOR A FIX REQUEST.
 *
 *  Two things a repair ask needs that the scheduler cannot provide inside a chat turn:
 *
 *  1. IF IT IS A ONE-FILE FIX, IT RUNS HERE, NOW, with the tools that exist for exactly this —
 *     read_artifact, search_artifact, update_artifact. Scheduling it instead is the reported complaint
 *     ("it just created a scheduled job to make the fix but it didn't start the fix") and it is also the
 *     worse tool for the job: a 200-line file with one broken line does not need a design document, a
 *     manifest, a supervisor and five scheduled steps; it needs the file read and one edit applied.
 *  2. IF THAT INLINE ATTEMPT DOES NOT LAND, THE DURABLE JOB TAKES OVER IN THE SAME TURN. `after()` runs
 *     once the inline turn is over and looks for EVIDENCE that the fix happened (the named file changed,
 *     and the lint no longer names it). If there is none, it starts the repair job and the response
 *     carries `scheduled`, which is what makes the client start driving the queue immediately.
 *
 *  A structural repair (several files, "fix everything", "keep going until it works") skips step 1 and is
 *  scheduled directly: it genuinely does not fit one invocation. */
export type TurnWire = {
  settings: any;
  fix: { artifactId: number; primary: string | null; targets: string[]; goal: string } | null;
  after: (result: any) => Promise<Record<string, unknown> | null>;
};

/** The files a repair target imports, as they actually ARE, for the repair prompt.
 *
 *  One hop, from content: a repair that cannot see the module a file imports cannot tell a wrong call site
 *  from a wrong export, and "WebGLRenderer is not a constructor" is a property of the MODULE, not of the
 *  line that constructs it. Capped so a big dependency cannot crowd out the file being repaired. */
function dependencyBrief(content: string, known: string[], selfPath: string, files: { path: string; content: string }[]): string[] {
  const deps = localImports(content, known, selfPath);
  const shown = files.filter((f) => deps.includes(f.path) && f.content.trim());
  if (!shown.length) return [];
  return [
    "THE FILES THIS FILE IMPORTS, AS THEY ACTUALLY ARE. Read these before deciding the root cause — if the "
      + "defect is on a line here that constructs/uses a binding, the fix may belong in the module that "
      + "declares it, not in the line itself:\n"
      + shown.slice(0, 4).map((f) => `--- ${f.path} ---\n${f.content.slice(0, 6_000)}`).join("\n\n"),
  ];
}

export async function wireTurn(q: string, session: string, settings: any, d: ScheduleDeps): Promise<TurnWire> {
  void d;
  const text = String(q ?? "").trim();
  const pass: TurnWire = { settings, fix: null, after: async () => null };
  if (settings?.scheduleBuilds === false || settings?.continuation || settings?.followup) return pass;
  if (!looksLikeRepair(text, !!settings?.focus?.id)) return pass;
  const id = repairTargetId(text, settings);
  if (!id) return pass;
  const lf = await listFiles(id);
  if (!lf) return pass;
  const askText = text.replace(/^\/(?:build|fix)\b\s*/i, "").trim();
  const parsed = parseRepairAsk(askText, String(settings?.focus?.file ?? ""));
  if (isStructuralRepair(parsed)) return pass; // the scheduler's job, not this turn's
  const pick = pickRepairTargets({ ask: parsed, askText, known: lf.files.map((f) => f.path), lint: lintArtifact(lf.files), missing: missingRefs(lf.files) });
  if (!pick.targets.length) return pass;
  const goal = repairGoal(askText, pick);
  const before = new Map(lf.files.map((f) => [f.path, f.content]));
  const focus = settings?.focus ?? {};
  const errors = [...(Array.isArray(focus.errors) ? focus.errors : []), ...parsed.errors, `repair goal: ${goal}`,
    ...(pick.findings[pick.primary ?? pick.targets[0]] ?? []).slice(0, 4)]
    .map((x) => String(x).slice(0, 400));
  const enriched = {
    ...settings,
    focus: {
      id, title: String(lf.artifact?.title ?? focus.title ?? ""), file: pick.primary ?? focus.file ?? pick.targets[0],
      files: lf.files.map((f) => f.path), selection: String(focus.selection ?? ""), errors: [...new Set(errors)].slice(-8),
    },
  };
  return {
    settings: enriched,
    fix: { artifactId: id, primary: pick.primary, targets: pick.targets, goal },
    after: async (result: any) => {
      // The turn was cut at max_tokens: the client auto-continues the SAME ask, and escalating now would
      // race that continuation against a scheduled job writing the same files.
      if (result?.truncated) return null;
      const events = Array.isArray(result?.toolEvents) ? result.toolEvents : [];
      const wrote = events.some((e: any) => /^(?:update_artifact|create_artifact)$/.test(String(e?.tool)) && !e?.error);
      const lf2 = await listFiles(id);
      const now = new Map((lf2?.files ?? []).map((f) => [f.path, f.content]));
      const lint = lf2 ? lintArtifact(lf2.files) : [];
      const unresolved = pick.targets.filter((t) => {
        const content = now.get(t);
        if (content === undefined || !content.trim()) return true;
        if (unchanged(before.get(t), content)) return true;
        return lint.some((i) => i.startsWith(t + ":"));
      });
      // EVIDENCE, NOT THE MODEL'S CLAIM. A successful-looking write is not enough (a call can report ok
      // and change nothing), and a changed file is not enough either (it can be rewritten into a different
      // breakage). A change plus a lint that no longer names the file is what "the fix landed" means here.
      if (wrote && unresolved.length === 0) return null;
      const job = await startRepair(session, id, askText, enriched);
      const progress = await buildProgress(job);
      const names = pick.targets.join(", ");
      // The escalation is written as its OWN message rather than appended to the reply. The reply was
      // already persisted by runAI before this hook runs, so appending here would show the note in the
      // live view and lose it on reload — the two would disagree about what the assistant said.
      const note = `The inline attempt did not change ${pick.primary ?? names}, so the repair continues as a job — no need to re-ask. `
        + `It re-diagnoses and re-repairs automatically until the reported failure is gone (or you press stop). Job \`${job}\`, files: ${names}.`;
      await d.addMsg("assistant", note, null, session, { scheduled: true, job, repair: true, escalated: true });
      return {
        scheduled: true, job, artifactId: id, repair: true, escalated: true, progress, scheduledNote: note,
        // The chat has handed this to the job: clearing the completion audit keeps the client from
        // auto-continuing the same fix in parallel with the queue that is now writing those files.
        completion: null,
      };
    },
  };
}

/** Chat -> scheduler. Returns the turn's response payload, or null when this ask is neither a build nor
 *  a repair, in which case the caller runs its ordinary inline turn.
 *
 *  THE POINT: neither a build nor a multi-file repair may be attempted inside one turn. The chat path ran
 *  a bounded tool loop in a single invocation, exhausted it, and answered with a placeholder - which is
 *  how an app designed with twelve files ended up with three and a claim of completion, and how "look at
 *  the errors and finish the app files" spent a whole invocation on a design brief and died. Here the ask
 *  becomes a persisted step graph that drains across many invocations and survives a closed tab.
 *
 *  The tick budget is 40s against the platform's ~60s kill, which is enough for plan (or diagnose) to
 *  finish inside THIS request - so the reply names the real files rather than promising some. The
 *  per-file steps are left queued on purpose; main-build-script.ts drives them. */
export async function maybeScheduleBuild(q: string, session: string, settings: any, d: ScheduleDeps): Promise<Record<string, unknown> | null> {
  const turnT0 = Date.now();
  const hasFocus = !!(settings?.focus && settings.focus.id);
  if (settings?.scheduleBuilds === false) return null;
  const isBuild = looksLikeAppBuild(q, hasFocus);
  const repairId = isBuild ? null : (looksLikeRepair(q, hasFocus) ? repairTargetId(q, settings) : null);
  if (!isBuild && repairId === null) return null;

  const ask = String(q).replace(/^\/(?:build|fix)\b\s*/i, "").trim();
  if (!ask) return null;

  // A ONE-FILE FIX IS NOT A JOB. Return null and let the caller run its ordinary tool loop, which is
  // where read_artifact and update_artifact live — the exact tools the ask named. Turning this into a
  // scheduled build is the reported failure ("I requested a fix and it just created a scheduled job"),
  // and it is also the wrong tool: the fix is a read plus one edit, inside one invocation, now.
  // A structural repair — several files, "fix everything", "keep going until it works" — still schedules,
  // because that genuinely does not fit one turn.
  if (repairId !== null) {
    const intent = parseRepairAsk(ask, String(settings?.focus?.file ?? ""));
    if (!isStructuralRepair(intent)) return null;
  }
  wireBuild(d);
  await d.ensureSession(session);

  // The user message is written only once the decision is FINAL. A repair whose diagnosis finds nothing
  // to repair returns null so the turn falls through to the ordinary inline loop - and that loop writes
  // the user message itself, so writing it here first would persist the same message twice.
  const tickBudget = () => Math.max(T.fastTick, Math.min(T.inRequestTick, T.responseDeadline - (Date.now() - turnT0) - T.returnReserve));
  let job: string, joined = false;
  if (repairId !== null) {
    // JOINED vs STARTED. `startRepair` returns an in-flight job unchanged — but the reply said "Scheduled
    // a repair" either way, so a user who re-sent the ask could not tell that the work was already
    // running. A repair that is already in flight is that promise being kept, and it says so.
    joined = (await jobStatus(jobIdFor(session, repairId))).pending > 0;
    job = await startRepair(session, repairId, ask, settings);
    await tick(tickBudget()).catch(() => {});
    const rstate = (await getJobState(job))?.repair;
    if (!(rstate?.targets ?? []).length) {
      // NOTHING TO DO vs NOTHING RAN YET. `diagnose` writes `checkedAt`; if it ran and found no target then
      // this ask genuinely has no repair and the inline loop should answer it. If the tick had no budget to
      // run diagnose at all, cancelling would turn a multi-file repair back into the one-invocation loop
      // that cannot finish it — so the job stands and the client starts driving it.
      if (rstate?.checkedAt) { await cancelJob(job); return null; }
    }
  } else {
    job = await startBuild(session, ask, settings);
    await tick(tickBudget()).catch(() => {});
  }
  await d.addMsg("user", q, null, session, null);
  const pr = await buildProgress(job);

  const planned = Number(pr.plannedFiles ?? 0);
  // A repair names ITS targets; a build names the files it planned.
  const names = repairId !== null
    ? ([] as unknown[]).concat(pr.targets ?? []).map(String).filter(Boolean)
    : (pr.files ?? []).map((f: any) => f.path).filter(Boolean);
  const tail = [
    "",
    "Job `" + job + "`. Each poll of `?build_status&job=" + job + "` runs the queue for up to 40s and returns progress; the interval val finishes it if you close the tab.",
    "",
    "It reports `complete` only when every file above actually exists with real content. `done` alone just means the queue drained.",
  ];
  // The reply states what is ALREADY RUNNING and what will happen without the user doing anything. The
  // old text ("Scheduled ... instead of attempting it in one turn ... poll ?build_status") described a
  // hand-off the user had not asked for and did not say the work had started; this one names the goal, the
  // files, the automatic loop and its two stopping conditions.
  const goal = String(pr.goal ?? "").slice(0, 200);
  const reply = repairId !== null
    ? [(joined ? "This repair of artifact #" + repairId + " was ALREADY RUNNING — this ask joins it rather than restarting it: " : "Repairing artifact #" + repairId + " now — ")
        + "**" + names.length + " file(s)**: " + (names.join(", ") || "(diagnosing)")
        + (goal ? "\n\nGoal: " + goal : ""),
      "",
      "It runs on its own from here: each round re-reads the files, repairs only what is still broken, and "
        + "checks the previous round actually changed something. It stops when the failure is gone, when it "
        + "has exhausted its rounds, or when you press **stop** — nothing to re-ask."]
      .filter(Boolean).join("\n")
    : planned > 0
    ? ["Scheduled instead of built in one pass: **" + planned + " files**, " + (planned + 4) + " steps queued.",
      "",
      names.length ? names.map((n: string) => "- " + n).join("\n") : "",
      ...tail].filter(Boolean).join("\n")
    : "Planning did not finish in this request. Job `" + job + "` is queued - poll `?build_status&job=" + job + "` to continue it.";

  await d.addMsg("assistant", reply, null, session, { scheduled: true, job });
  return { reply, sessionName: "", toolEvents: [], reasoning: [], truncated: false, scheduled: true, job, artifactId: pr.artifactId ?? null, progress: pr, repair: repairId !== null || undefined, meta: { scheduled: true, plannedFiles: planned, repair: repairId !== null } };
}
