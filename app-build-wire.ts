// THE WIRE. app-build.ts declares the scheduled build pipeline and app-swarm.ts implements the three
// operations it needs, but nothing connected them - registerBuildHandlers() had no caller, so a job that
// enqueued a "plan" or "build" step would have failed with "no handler for kind". The whole scheduled
// pipeline was dead code while the live path still tried to build an app in one response.
//
// This file is the one-directional seam: app.tsx owns PassMeter and the session helpers, app-swarm.ts owns
// the model calls, app-build.ts owns the step graph. Passing the dependencies through here instead of
// importing app.tsx keeps the import graph acyclic.
import { T } from "./timing.ts";
import { buildProgress, cancelJob, getJobState, registerBuildHandlers, startBuild, startRepair } from "./app-build.ts";
import { tick } from "./scheduler.ts";
import { buildFileOnce, conformApp, designApp, PLACEHOLDER_MARK, planApp, type SwarmDeps } from "./app-swarm.ts";
import { lintArtifact, listFiles, saveMany } from "./artifacts.ts";
import { importsOf } from "./plan.ts";

let wired = false;

/** Called once at module load by app.tsx. Idempotent: registering a handler twice would silently shadow. */
export function wireBuild(d: SwarmDeps): void {
  if (wired) return;
  wired = true;
  registerBuildHandlers({
    conform: async (_job, st) => conformApp(String(st.ask ?? ""), Number(st.artifactId), st.settings ?? {}, d),

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

    buildFile: async (_job, st, path, directives) => {
      // A REPAIR builder is not a fresh builder. It gets the file as it stands, the findings against that
      // specific file, and the errors the user reported - because "rewrite this file from its purpose
      // line" on a file that is 90% correct is how a repair turns into a regression.
      const repairPre: string[] = [];
      if (st.repair) {
        const lf = await listFiles(Number(st.artifactId));
        const cur = lf?.files.find((f) => f.path === path);
        const findings: string[] = (st.repair.findings ?? {})[path] ?? [];
        repairPre.push(cur
          ? `REPAIR, NOT A REWRITE. ${path} already exists and most of it is correct. Return the COMPLETE file with the defects below fixed and everything else byte-for-byte unchanged. Do not drop features, do not restyle, do not rename anything other files import.`
          : `WRITE THIS MISSING FILE. ${path} does not exist yet, and the page already loads it — that absence IS the 404 being reported. Write the real file the page expects, consistent with its siblings.`);
        if (findings.length) repairPre.push(`Defects to fix in ${path}:\n` + findings.map((x) => "- " + x).join("\n"));
        if (st.repair.errors) repairPre.push("What the user reported:\n" + String(st.repair.errors).slice(0, 1_500));
        // 16k of the current file: enough for anything this system generates, and it still leaves room
        // under a per-call token budget for the design document and the supervisor's directives.
        if (cur) repairPre.push(`CURRENT CONTENTS of ${path} (${cur.content.length} chars):\n` + cur.content.slice(0, 16_000));
      }
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
      const r = await buildFileOnce(String(st.session ?? "default"), Number(st.artifactId), manifestWithAsk, path, st.settings ?? {}, d, withDesign);
      return { issues: r.issues ?? [], truncated: !!r.truncated };
    },

    // Integration is a REPAIR pass, not another generation pass: by the time it runs every file exists, so
    // the only thing left worth doing is fixing what the cross-file lint can actually see. When the lint is
    // clean this writes nothing at all - an integration step that always rewrites files would undo good work
    // on every run.
    integrate: async (_job, st, issues) => {
      const id = Number(st.artifactId);
      const lf = await listFiles(id);
      if (!lf) throw new Error("artifact vanished before integration");
      const index = lf.files.find((f) => /^index\.html?$/i.test(f.path));
      if (index && index.content.includes(PLACEHOLDER_MARK)) {
        // The plan-time placeholder shell is still in place, which means no builder ever wrote index.html.
        // Leaving it would ship a page that says "building 8 files..." forever.
        return { repaired: false, note: "index.html is still the plan-time placeholder", issues };
      }
      if (!issues.length) return { repaired: false, note: "cross-file lint clean; nothing to repair", files: lf.files.length };
      const worst = issues.slice(0, 12);
      const r = await buildFileOnce(String(st.session ?? "default"), id, st.manifest, index?.path ?? lf.files[0].path, st.settings ?? {}, d,
        ["Integration repair pass. Fix exactly these cross-file defects and change nothing else:", ...worst]);
      const after = await listFiles(id);
      return { repaired: !!r.written, fixedAgainst: worst, remaining: after ? lintArtifact(after.files) : issues };
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
  const noun = /\b(app|application|game|website|web site|site|dashboard|editor|tracker|tool|clone|simulator|visuali[sz]er)\b/i.test(t);
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

/** The artifact a repair is about: the focused one, else the first #<id> in the text. */
function repairTargetId(text: string, settings: any): number | null {
  const focus = Number(settings?.focus?.id);
  if (Number.isInteger(focus) && focus > 0) return focus;
  const m = /#(\d+)\b/.exec(String(text ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export type ScheduleDeps = SwarmDeps & {
  addMsg: (role: string, content: string, a: unknown, session: string, meta: unknown) => Promise<unknown>;
};

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
  const hasFocus = !!(settings?.focus && settings.focus.id);
  if (settings?.scheduleBuilds === false) return null;
  const isBuild = looksLikeAppBuild(q, hasFocus);
  const repairId = isBuild ? null : (looksLikeRepair(q, hasFocus) ? repairTargetId(q, settings) : null);
  if (!isBuild && repairId === null) return null;

  const ask = String(q).replace(/^\/(?:build|fix)\b\s*/i, "").trim();
  if (!ask) return null;
  wireBuild(d);
  await d.ensureSession(session);

  // The user message is written only once the decision is FINAL. A repair whose diagnosis finds nothing
  // to repair returns null so the turn falls through to the ordinary inline loop - and that loop writes
  // the user message itself, so writing it here first would persist the same message twice.
  let job: string;
  if (repairId !== null) {
    job = await startRepair(session, repairId, ask, settings);
    await tick(T.inRequestTick).catch(() => {});
    const targets: string[] = (await getJobState(job))?.repair?.targets ?? [];
    if (!targets.length) { await cancelJob(job); return null; }
  } else {
    job = await startBuild(session, ask, settings);
    await tick(T.inRequestTick).catch(() => {});
  }
  await d.addMsg("user", q, null, session, null);
  const pr = await buildProgress(job);

  const planned = Number(pr.plannedFiles ?? 0);
  const names = (pr.files ?? []).map((f: any) => f.path).filter(Boolean);
  const tail = [
    "",
    "Job `" + job + "`. Each poll of `?build_status&job=" + job + "` runs the queue for up to 40s and returns progress; the interval val finishes it if you close the tab.",
    "",
    "It reports `complete` only when every file above actually exists with real content. `done` alone just means the queue drained.",
  ];
  const reply = repairId !== null
    ? ["Scheduled a repair of artifact #" + repairId + " instead of attempting it in one turn: **" + names.length + " file(s)** to fix, " + (names.length + 3) + " steps queued.",
      "",
      names.length ? names.map((n: string) => "- " + n).join("\n") : "",
      ...tail].filter(Boolean).join("\n")
    : planned > 0
    ? ["Scheduled instead of built in one pass: **" + planned + " files**, " + (planned + 4) + " steps queued.",
      "",
      names.length ? names.map((n: string) => "- " + n).join("\n") : "",
      ...tail].filter(Boolean).join("\n")
    : "Planning did not finish in this request. Job `" + job + "` is queued - poll `?build_status&job=" + job + "` to continue it.";

  await d.addMsg("assistant", reply, null, session, { scheduled: true, job });
  return { reply, sessionName: "", toolEvents: [], reasoning: [], truncated: false, scheduled: true, job, artifactId: pr.artifactId ?? null, progress: pr, meta: { scheduled: true, plannedFiles: planned, repair: repairId !== null } };
}
