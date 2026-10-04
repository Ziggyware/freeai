// Swarm build endpoints (?plan, ?build_file): one user action → many val invocations, each under its
// own 60 s. Dependencies from app.tsx are injected to avoid an import cycle.
import { T } from "./timing.ts";
import { renderPrompt } from "./prompts.ts";
import { readJsonBody } from "./app-helpers.ts";
import { applyEdits, fingerprint, parseModelJson, type Edit } from "./repair.ts";
import { clientStatusFor } from "./app-boundary.ts";
import { buildProgress, jobIdFor, jobTasks, startBuild, stopJob } from "./app-build.ts";
import { tick } from "./scheduler.ts";
import { drainOne, driveQueue, DRAIN_HEADER, FANOUT_WIDTH } from "./swarm-fanout.ts";
import "./scheduler-tasks.ts"; // handler registration is a side effect and must happen before any tick()
import { lintArtifact, listFiles, readFile, saveMany, stripModuleSyntax } from "./artifacts.ts";
import { stripTypeScript } from "./heal.ts";
import { buildReport, formatRepairBrief, type ErrorReport } from "./errors.ts";
import { activeSkills, normalizeSettings } from "./app-settings.ts";
import { all, run, sql, unwrap } from "./db.ts";
/** Attached to every swarm error body. The status line alone cannot distinguish "this app failed" from
 *  "the network failed", and that ambiguity cost real debugging time. */
/** The plan-time shell writes this into index.html so the artifact is viewable while builders run. It is
 *  NOT a built file, and anything counting files must exclude it or a build that produced nothing still
 *  shows index.html present. */
export const PLACEHOLDER_MARK = "__omni_placeholder__";

/** Is this reply a FILE, or is it the model talking?
 *
 *  The fence matcher falls back to the whole raw reply when no fenced block is present - a deliberate
 *  tolerance for models that ignore the "output only a fenced block" instruction. But it accepted ANY
 *  text, so "Sure! Here is the file you asked for." was written to disk as a .js file and counted as a
 *  successfully built file. That is the worst possible outcome: not a failure, a fake success.
 *
 *  Prose destined for .md/.txt is legitimate, so those are judged on substance rather than syntax. */
export function looksLikeFileContent(path: string, text: string): boolean {
  const t = text.trim();
  if (t.length < 20) return false;
  if (/^(sure|certainly|here(\'s| is)|okay|ok|of course|i(\'ll| will)|let me|below is|as requested)\b/i.test(t) && !/[\n]/.test(t)) return false;
  if (/\.(md|txt|csv)$/i.test(path)) return t.length >= 40 || /^#/m.test(t);
  // Everything else is code or markup: it needs structure, not just length.
  return /[\n]/.test(t) && /[{}<>;=]|\b(function|const|let|var|class|import|export|def)\b/.test(t);
}

const APP_LEVEL_NOTE = "This is the build step reporting its own failure - the request reached the app and the app answered. It is not a gateway or network error, whatever the status line in DevTools says.";

export type SwarmDeps = {
  PassMeter: any; // class from app-meter.ts: new PassMeter(ceiling, emit, model, settings, hardDeadline)
  deriveTitle: (text: string) => string;
  clean: (s: string) => string;
  ensureSession: (id: string) => Promise<unknown>;
};
/** DESIGN: ask -> one design document, before any file exists.
 *
 *  The stage this closes: the planner used to go straight from a sentence to a file list, so every
 *  builder inferred the domain independently. For "a holographic interference app" that means each file
 *  invents its own idea of the physics, and nothing agrees. The design document is written once, stored
 *  in job state, and handed verbatim to the planner and to every builder. */
export async function designApp(ask: string, session: string, rawSettings: any, d: SwarmDeps, deadline?: number): Promise<{ design: string; meta: any }> {
  const settings = normalizeSettings(rawSettings ?? {});
  const { PassMeter, ensureSession } = d;
  await ensureSession(session);
  const meter = new PassMeter(2, () => {}, settings.model, settings, deadline ?? null);
  const skillsOn = activeSkills(settings.skills, ask);
  const prompt = meter.p("design", {
    ask,
    user: settings.system ? `\nUser instructions: ${settings.system}\n` : "",
    skills: skillsOn.length ? "\n" + skillsOn.map((k: any) => renderPrompt("skill", { name: k.name, body: k.body }, settings.prompts)).join("\n") : "",
  });
  const r = await meter.call(
    [{ role: "system", content: "Output only the markdown design document." }, { role: "user", content: prompt }],
    undefined, settings.model ?? "coder", { expect: 6000, temperature: 0.3 },
  );
  const text = String(r?.message?.content ?? "").replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (text.length < 200) throw Object.assign(new Error(`the designer returned ${text.length} characters, which is not a design document`), { status: 503, retryable: true });
  return { design: text, meta: r?.meta ?? null };
}

/** PLAN one app: ask -> manifest + artifact shell + durable build_job/build_file rows.
 *  Exported because it now has TWO callers that must not drift: the ?plan HTTP route (the old
 *  do-it-all-now path) and the scheduler's "plan" step. One implementation, two entry points. */
export async function planApp(ask: string, session: string, rawSettings: any, d: SwarmDeps, opts: { design?: string; artifactId?: number | null; deadline?: number } = {}): Promise<{ manifest: any; artifactId: number | null; title: string; meta: any }> {
  // Normalize HERE, not only at the HTTP edge. The ?plan route normalized on the way in and the scheduler
  // did not, so a scheduled build died on settings.skills being undefined three layers down.
  const settings = normalizeSettings(rawSettings ?? {});
  const { PassMeter, deriveTitle, clean: _clean, ensureSession } = d;
  await ensureSession(session);
  const meter = new PassMeter(3, () => {}, settings.model, settings, opts.deadline ?? null);
  const skillsOn = activeSkills(settings.skills, ask);
  const prompt = meter.p("architect", { ask, design: String(opts.design ?? "(no design document was produced; derive the file list from the ask alone)"), user: settings.system ? `\nUser instructions: ${settings.system}\n` : "", skills: skillsOn.length ? "\n" + skillsOn.map((k: any) => renderPrompt("skill", { name: k.name, body: k.body }, settings.prompts)).join("\n") : "" });
      const r = await meter.call([{ role: "system", content: "Output only JSON." }, { role: "user", content: prompt }], undefined, settings.model ?? "coder", { expect: 3000, temperature: 0.2 });
      const raw = String(r?.message?.content ?? "");
      const j = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      const manifest = JSON.parse(j);
      if (!Array.isArray(manifest.files) || !manifest.files.length) throw Object.assign(new Error("the planner returned a manifest with no files"), { status: 503, retryable: true });
      manifest.features = [].concat(manifest.features ?? []).map(String).slice(0, 20); manifest.visual = String(manifest.visual ?? "");
      manifest.files = manifest.files.filter((f: any) => f && typeof f.path === "string").map((f: any) => ({ path: f.path.replace(/^\.\//, ""), purpose: String(f.purpose ?? ""), exports: [].concat(f.exports ?? []).map(String), imports: [].concat(f.imports ?? []).map(String), notes: String(f.notes ?? "") }));
      if (!manifest.files.some((f: any) => /^readme\.md$/i.test(f.path))) manifest.files.push({ path: "README.md", purpose: "what it is, every feature, controls/shortcuts, how to run (static host or open index.html), file map", exports: [], imports: [], notes: "markdown; ≥ 10 feature bullets" });
      if (!manifest.files.some((f: any) => /^index\.html?$/.test(f.path))) manifest.files.unshift({ path: "index.html", purpose: "entry: markup + boot; loads every sibling", exports: [], imports: manifest.files.map((f: any) => f.path), notes: "" });
      const title = String(manifest.title ?? deriveTitle(ask)).slice(0, 60);
      // REUSE the artifact when the job already has one. saveMany(session, null, …) always CREATES, so a
      // retried plan step - one crash, one provider timeout - produced a SECOND artifact for a single
      // request. That is the "it made two artifacts instead of one" report: the request never asked for
      // two, a retry did. Passing the existing id makes plan idempotent.
      const shellFiles = [
        { path: "index.html", content: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p style="font:14px monospace" data-omni="${PLACEHOLDER_MARK}">building ${manifest.files.length} files…</p></body></html>` },
        { path: "manifest.json", content: JSON.stringify({ ...manifest, ask }, null, 2) },
      ];
      // The design document ships WITH the app: it is what every builder was written against, so it is
      // the one file that explains why the rest look the way they do.
      if (opts.design) shellFiles.push({ path: "DESIGN.md", content: opts.design });
      const existingId = Number.isInteger(Number(opts.artifactId)) && Number(opts.artifactId) > 0 ? Number(opts.artifactId) : null;
      const shell = await saveMany(session, existingId, title, shellFiles);
      // Durable plan + per-file registry (build_job/build_file — see db.ts) so "what files exist and what state
      // are they in" has one queryable answer instead of living only in the client's in-memory manifest card and
      // an ephemeral, delete-on-completion omni_state blob. One row per manifest file, all starting "queued".
      if (shell?.id) {
        const now = Date.now();
        await run(sql`INSERT INTO build_job (artifact_id, session, title, ask, manifest, status, created_ts, updated_ts)
          VALUES (${shell.id}, ${session}, ${title}, ${ask.slice(0, 2000)}, ${JSON.stringify(manifest).slice(0, 60_000)}, 'planned', ${now}, ${now})
          ON CONFLICT(artifact_id) DO UPDATE SET manifest = excluded.manifest, title = excluded.title, ask = excluded.ask, status = 'planned', updated_ts = excluded.updated_ts`);
        for (const f of manifest.files) {
          await run(sql`INSERT INTO build_file (artifact_id, path, purpose, status, updated_ts) VALUES (${shell.id}, ${f.path}, ${String(f.purpose ?? "").slice(0, 500)}, 'queued', ${now})
            ON CONFLICT(artifact_id, path) DO UPDATE SET purpose = excluded.purpose, status = 'queued', updated_ts = excluded.updated_ts`);
        }
      }
      return { manifest, artifactId: shell?.id ?? null, title, meta: r?.meta ?? null };
}

/** CONFORM: does what was built answer what was ASKED?
 *
 *  The drift this closes, in the user's words: "i keep asking for something and then the ai creates
 *  something completely different." It was structural, not bad luck. The pipeline is
 *
 *      ask -> design (a MODEL RESTATES the ask) -> plan (reads the design) -> builders (read the design)
 *
 *  and the design document was made binding. After that one restatement the user's actual sentence was
 *  never consulted again by any stage, and nothing anywhere compared the finished artifact to it: verify
 *  reconciles files against the MANIFEST, which is a description of the drifted plan, so a build that
 *  produced a dashboard when a holographic interference simulator was asked for reported itself complete
 *  and correct. Two changes answer it: every builder now gets the ask verbatim (above), and this step
 *  judges the result against it.
 *
 *  It deliberately does not look at code quality - verify and the lints already do - only at subject and
 *  substance, because that is the axis drift happens on. */
export async function conformApp(ask: string, artifactId: number, rawSettings: any, d: SwarmDeps): Promise<{ matches: boolean; built: string; mismatches: string[]; extra: string[] }> {
  const settings = normalizeSettings(rawSettings ?? {});
  const { PassMeter } = d;
  const lf = await listFiles(artifactId);
  if (!lf) throw Object.assign(new Error(`artifact ${artifactId} has no files to judge`), { status: 400 });
  const readme = lf.files.find((f) => /^readme\.md$/i.test(f.path));
  const meter = new PassMeter(2, () => {}, settings.model, settings);
  const prompt = meter.p("conform", {
    ask: String(ask ?? "").slice(0, 4000),
    title: String(lf.artifact?.title ?? ""),
    files: lf.files.map((f) => `- ${f.path} (${f.content.length} chars)`).join("\n"),
    readme: readme ? readme.content.slice(0, 3000) : "(no README.md)",
  });
  const r = await meter.call([{ role: "system", content: "You audit whether a build answers its request. Output only JSON." }, { role: "user", content: prompt }], undefined, settings.model ?? "fast", { expect: 500, maxTokens: 900, temperature: 0.1 });
  const raw = String(r?.message?.content ?? "");
  const j = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let parsed: any;
  try { parsed = JSON.parse(j); } catch { throw Object.assign(new Error(`the conformance judge did not return JSON: ${raw.slice(0, 120)}`), { status: 503, retryable: true }); }
  const list = (v: unknown) => [].concat((v ?? []) as any).filter((x: unknown) => typeof x === "string" && x.trim()).slice(0, 10) as string[];
  const mismatches = list(parsed.mismatches);
  return {
    // A verdict of "matches" alongside listed mismatches is incoherent; the mismatches are the evidence,
    // so they decide. Otherwise a judge can wave a build through while naming everything wrong with it.
    matches: parsed.matches !== false && mismatches.length === 0,
    built: String(parsed.built ?? "").slice(0, 300),
    mismatches,
    extra: list(parsed.extra),
  };
}

/** Ensure the build_job row a build_file row REQUIRES exists.
 *
 *  build_file.artifact_id REFERENCES build_job(artifact_id), and db.ts turns foreign keys ON. Only
 *  planApp ever inserted a build_job row — so on the REPAIR path, where there is no plan step at all,
 *  every build_file write violated the constraint and was thrown away by a bare `.catch(() => {})`.
 *  The durable per-file record silently did not exist for repairs: no status, no attempts, no error
 *  text, for exactly the jobs whose whole purpose is fixing what is broken.
 *
 *  Upserting the parent here rather than adding another INSERT to the repair path means any future
 *  caller of buildFileOnce gets it too, instead of rediscovering this the same way. */
async function ensureBuildJob(artifactId: number, session: string, manifest: any, ask: string): Promise<void> {
  const now = Date.now();
  await run(sql`INSERT INTO build_job (artifact_id, session, title, ask, manifest, status, created_ts, updated_ts)
    VALUES (${artifactId}, ${session}, ${String(manifest?.title ?? "").slice(0, 200)}, ${String(ask ?? "").slice(0, 2000)}, ${JSON.stringify(manifest ?? {}).slice(0, 60_000)}, 'building', ${now}, ${now})
    ON CONFLICT(artifact_id) DO UPDATE SET updated_ts = excluded.updated_ts`);
}

/** BUILD one file. Same two callers as planApp: the ?build_file route and the scheduler's "build" step.
 *  `directives` are the supervisor's accumulated instructions (brain.ts) - empty from the HTTP route. */
export async function buildFileOnce(session: string, id: number, manifest: any, path: string, rawSettings: any, d: SwarmDeps, directives: string[] = [], deadline?: number) {
  const settings = normalizeSettings(rawSettings ?? {});
  const { PassMeter } = d;
  const spec = manifest?.files?.find((f: any) => f.path === path);
  if (!spec) throw Object.assign(new Error(`no manifest entry for ${path}`), { status: 400 });
    const meter = new PassMeter(6, () => {}, settings.model, settings, deadline ?? null);
    const compact = manifest.files.map((f: any) => `${f.path}: ${f.purpose}${f.exports?.length ? ` — exports ${f.exports.join(", ")}` : ""}`).join("\n");
    const extra = directives.length ? "\n\nSUPERVISOR DIRECTIVES (apply all):\n" + directives.map((x) => "- " + x).join("\n") : "";
    const prompt = meter.p("builder", { ask: String(manifest.ask ?? "(the original request was not recorded for this job)"), title: String(manifest.title ?? ""), path, purpose: spec.purpose, exports: spec.exports?.join(", ") || "(none)", imports: spec.imports?.join(", ") || "(none)", shared: String(manifest.shared ?? ""), manifest: compact, notes: spec.notes || "(none)", features: [].concat(manifest.features ?? []).map((x: unknown, i: number) => `${i + 1}. ${String(x)}`).join("\n") || "(see purpose)", visual: String(manifest.visual ?? "(designer's choice: tokens, dark default, real identity)") }) + extra;
      const r = await meter.call([{ role: "system", content: "You write one complete source file. Output only a fenced code block." }, { role: "user", content: prompt }], undefined, settings.model ?? "coder", { expect: 6000, temperature: 0.2 });
      const raw = String(r?.message?.content ?? "");
      const fence = raw.match(/```[\w.+-]*\s*\n([\s\S]*?)\n```\s*$/m) ?? raw.match(/```[\w.+-]*\s*\n([\s\S]*)$/m);
      let content = (fence ? fence[1] : raw).replace(/\n```\s*$/, "");
      if (!content.trim()) throw Object.assign(new Error("the model returned no file content"), { status: 503, retryable: true });
      // Models emit TypeScript into .js files. The browser throws at the first annotation, so the
      // file as written is dead. Strip only when the original does not parse and the stripped version does.
      if (/\.m?js$/i.test(path)) {
        const parses = (s: string) => { try { new Function(stripModuleSyntax(s)); return true; } catch { return false; } };
        if (!parses(content)) {
          const stripped = stripTypeScript(content);
          if (stripped !== content && parses(stripped)) content = stripped;
        }
      }
      if (!fence && !looksLikeFileContent(path, content)) {
        throw Object.assign(new Error(`the model replied with prose instead of a file for ${path} (no fenced code block, and the text is not file content): ${content.trim().slice(0, 80)}`), { status: 503, retryable: true });
      }
      const w = await saveMany(session, id, "", [{ path, content }]);
      // THE WRITE MUST HAVE LANDED. `written: !!w` was the old check, and saveMany returns an object even
      // when it wrote nothing: a file over its 3 MB per-file cap, or a path its sanitiser rejects, is
      // filtered out of the batch before any INSERT, and a failed INSERT is skipped silently. The build
      // step then reported SUCCESS for a file that does not exist - so verify found it missing, rebuilt
      // it, got the same silent non-write, and after VERIFY_ROUNDS the job gave up incomplete with no
      // error anywhere saying why. Exactly one file goes in, so a non-empty `written` is the proof.
      if (!w || !w.written.length) {
        throw Object.assign(new Error(
          `${path} was generated (${content.length} chars) but the write did not land. A single file may not exceed 3,000,000 characters and the path must be a plain relative path; regenerate ${path} smaller, or split it into modules the manifest already lists.`,
        ), { status: 503, retryable: true });
      }
      // builders run in parallel, so cross-file checks are meaningless here: report only this file's own defects (syntax, JSON, blocked externals)
      const own = lintArtifact([{ path, content }]).filter((i) => !/does not exist|imports \{/.test(i));
      const truncated = r?.finishReason === "length";
      // Persist this attempt's outcome into build_file — the durable per-file record — regardless of how the
      // manifest card is currently rendered client-side. ON CONFLICT because a file rebuilt via the manifest's
      // single-file "rebuild" button, or a job resumed after this row's artifact_id/path pair already exists,
      // both hit the same (artifact_id, path) primary key as the original plan-time insert.
      await ensureBuildJob(id, session, manifest, String(manifest?.ask ?? ""));
      // NOT swallowed any more. A failed write here means the per-file record is missing, and the only
      // thing worse than that is not knowing: the build still succeeds, but the failure is visible.
      const bf = await run(sql`INSERT INTO build_file (artifact_id, path, purpose, status, lines, issues, error, attempts, updated_ts)
        VALUES (${id}, ${path}, ${String(spec.purpose ?? "").slice(0, 500)}, ${truncated || own.length ? "issues" : "ok"}, ${content.split("\n").length}, ${JSON.stringify(own).slice(0, 4000)}, NULL, 1, ${Date.now()})
        ON CONFLICT(artifact_id, path) DO UPDATE SET status = excluded.status, lines = excluded.lines, issues = excluded.issues, error = NULL, attempts = build_file.attempts + 1, updated_ts = excluded.updated_ts`);
      if (!bf.ok) console.error(`[build] build_file row for ${path} was not written:`, bf.error);
      return { ok: true as const, path, chars: content.length, lines: content.split("\n").length, truncated, issues: own, written: w.written.length > 0, meta: r?.meta ?? null };
}

/** REPAIR one file: the smallest correct edit, plus the root cause, in one call.
 *
 *  Why this is not `buildFileOnce` with a different prompt. A builder is asked for a COMPLETE FILE from a
 *  purpose line, which is the right operation when no file exists and the wrong one when a 200-line file
 *  has one broken line: the model re-derives everything, and every re-derivation is a chance to change
 *  something that was already correct. The reported run is what that looks like in practice — a "fix" that
 *  rewrote render.js and left the constructor error in it.
 *
 *  So the contract here is an EDIT LIST over the file the user actually has: exact find→replace pairs
 *  applied with update_artifact's semantics (each `find` must occur exactly once), a stated root cause,
 *  and a full-file rewrite permitted only as an explicit fallback that says why. A round in which nothing
 *  is applicable is reported as `changed: false` — never as a completed repair. */
export type FileRepair = {
  path: string; written: boolean; changed: boolean; chars: number; beforeChars: number;
  rootCause: string; note: string; edits: number; failedEdits: string[]; noopReason?: string;
  truncated: boolean; issues: string[];
};

export async function repairFileOnce(
  session: string, id: number, manifest: any, path: string, rawSettings: any, d: SwarmDeps,
  o: { goal?: string; findings?: string[]; directives?: string[]; current?: string; deadline?: number } = {},
): Promise<FileRepair> {
  const settings = normalizeSettings(rawSettings ?? {});
  const { PassMeter } = d;
  const spec = (manifest?.files ?? []).find((f: any) => f.path === path) ?? { path, purpose: "", exports: [], imports: [], notes: "" };
  const before = o.current !== undefined ? String(o.current) : ((await readFile(id, path))?.content ?? "");
  const siblings = (manifest?.files ?? []).map((f: any) => String(f.path)).filter((p: string) => p && p !== path);
  const meter = new PassMeter(4, () => {}, settings.model, settings, o.deadline ?? null);
  const prompt = meter.p("repair", {
    ask: String(manifest?.ask ?? "").slice(0, 3000),
    path,
    title: String(manifest?.title ?? ""),
    purpose: String(spec.purpose ?? "").slice(0, 400),
    goal: String(o.goal ?? "").slice(0, 600) || String(manifest?.ask ?? "").slice(0, 400),
    findings: (o.findings ?? []).length ? o.findings.map((x) => "- " + String(x).slice(0, 300)).join("\n") : "(none recorded — the reported failure is the brief)",
    files: siblings.join(", ") || "(none)",
    current: before.slice(0, 16_000),
    user: settings.system ? `\nUser instructions: ${settings.system}\n` : "",
  });
  const extra = (o.directives ?? []).length ? "\n\nSUPERVISOR DIRECTIVES (apply all):\n" + (o.directives ?? []).map((x) => "- " + x).join("\n") : "";
  const r = await meter.call(
    [{ role: "system", content: "You repair one file with the smallest correct edit, and name the root cause. Output only the JSON object described." }, { role: "user", content: prompt + extra }],
    undefined, settings.model ?? "coder", { expect: 1200, maxTokens: 3000, temperature: 0.1 },
  );
  const raw = String(r?.message?.content ?? "");
  const parsed = parseModelJson(raw);
  if (!parsed) throw Object.assign(new Error(`the repair model did not return the edit JSON for ${path}: ${raw.slice(0, 140)}`), { status: 503, retryable: true });
  const rootCause = String(parsed.rootCause ?? "").trim().slice(0, 600);
  const note = String(parsed.note ?? "").trim().slice(0, 300);
  const edits: Edit[] = (Array.isArray(parsed.edits) ? parsed.edits : [])
    .filter((e: any) => e && typeof e.find === "string" && typeof e.replace === "string")
    .slice(0, 12)
    .map((e: any) => ({ find: String(e.find), replace: String(e.replace) }));
  const applied = applyEdits(before, edits);
  let content = applied.applied > 0 ? applied.content : "";
  let mode: "edits" | "rewrite" = "edits";
  if (!content && typeof parsed.content === "string" && parsed.content.trim().length >= 20) { content = parsed.content; mode = "rewrite"; }
  const truncated = r?.finishReason === "length";

  // NOTHING APPLICABLE. This is a failed repair, and it says so: the caller records `changed: false`, the
  // round is judged unresolved, and the next round gets different instructions. Reporting a completed
  // step that changed nothing is the exact failure this file exists to end.
  if (!content) {
    const noopReason = applied.failed.length ? applied.failed.join("; ") : (edits.length ? "no edit applied" : "the model returned no edits and no replacement content");
    return { path, written: false, changed: false, chars: before.length, beforeChars: before.length, rootCause, note, edits: edits.length, failedEdits: applied.failed, noopReason, truncated, issues: [] };
  }
  // A REWRITE MUST NOT TRUNCATE THE FILE. Free tiers cut mid-output; a 900-char stub replacing a
  // 6,000-char file reads as a successful write everywhere downstream.
  if (mode === "rewrite" && before.length > 400 && content.length < before.length * 0.3) {
    throw Object.assign(new Error(`the repair returned a rewrite of ${path} that is ${content.length} chars against the original ${before.length} — that is a truncation, not a fix. Re-send the complete file, or express the change as edits.`), { status: 503, retryable: true });
  }
  if (/\.m?js$/i.test(path)) {
    const parses = (s: string) => { try { new Function(stripModuleSyntax(s)); return true; } catch { return false; } };
    if (!parses(content)) { const stripped = stripTypeScript(content); if (stripped !== content && parses(stripped)) content = stripped; }
  }
  const changed = fingerprint(content) !== fingerprint(before);
  if (!changed) {
    return { path, written: false, changed: false, chars: content.length, beforeChars: before.length, rootCause, note, edits: applied.applied, failedEdits: applied.failed, noopReason: "the repair produced byte-identical content", truncated, issues: [] };
  }
  const w = await saveMany(session, id, "", [{ path, content }]);
  if (!w || !w.written.length) throw Object.assign(new Error(`${path} was repaired (${content.length} chars) but the write did not land`), { status: 503, retryable: true });
  const own = lintArtifact([{ path, content }]).filter((i) => !/does not exist|imports \{/.test(i));
  await ensureBuildJob(id, session, manifest, String(manifest?.ask ?? ""));
  const bf = await run(sql`INSERT INTO build_file (artifact_id, path, purpose, status, lines, issues, error, attempts, updated_ts)
    VALUES (${id}, ${path}, ${String(spec.purpose ?? "").slice(0, 500)}, ${truncated || own.length ? "issues" : "ok"}, ${content.split("\n").length}, ${JSON.stringify(own).slice(0, 4000)}, NULL, 1, ${Date.now()})
    ON CONFLICT(artifact_id, path) DO UPDATE SET status = excluded.status, lines = excluded.lines, issues = excluded.issues, error = NULL, attempts = build_file.attempts + 1, updated_ts = excluded.updated_ts`);
  if (!bf.ok) console.error(`[repair] build_file row for ${path} was not written:`, bf.error);
  return { path, written: true, changed: true, chars: content.length, beforeChars: before.length, rootCause, note, edits: applied.applied, failedEdits: applied.failed, truncated, issues: own };
}

/** Returns a Response for ?plan / ?build_file, or null when the request is not a swarm route. */
export async function handleSwarm(req: Request, url: URL, d: SwarmDeps): Promise<Response | null> {
  const method = req.method;
  const { PassMeter, deriveTitle, clean, ensureSession } = d;
  // ── swarm build: one user action → many val invocations, each under its own 60 s ──
  // POST ?plan {q, session, settings} → manifest + an artifact shell (index placeholder + manifest.json) builders write into.
  if (method === "POST" && url.searchParams.has("plan")) {
    const b = await readJsonBody(req);
    const settings = normalizeSettings(b.settings ?? {});
    const session = String(b.session ?? "default"), ask = clean(String(b.q ?? ""));
    if (!ask) return Response.json({ error: { message: "empty ask" } }, { status: 400 });
    try {
      return Response.json(await planApp(ask, session, settings, d));
    } catch (e: any) {
      return Response.json({ error: { message: `plan failed: ${String(e?.message ?? e).slice(0, 300)}`, details: [APP_LEVEL_NOTE] } }, { status: clientStatusFor(e) });
    }
  }
  // POST ?build_file {session, artifactId, manifest, path, settings} → writes that one file (auto-continued), returns lint issues.
  if (method === "POST" && url.searchParams.has("build_file")) {
    const b = await readJsonBody(req);
    const settings = normalizeSettings(b.settings ?? {});
    const session = String(b.session ?? "default"), id = Number(b.artifactId), manifest = b.manifest, path = String(b.path ?? "");
    if (!Number.isInteger(id) || !manifest?.files?.some((f: any) => f.path === path)) return Response.json({ error: { message: "bad artifactId/path" } }, { status: 400 });
    try {
      return Response.json(await buildFileOnce(session, id, manifest, path, settings, d));
    } catch (e: any) {
      const errMsg = `build ${path} failed: ${String(e?.message ?? e).slice(0, 300)}`;
      await ensureBuildJob(id, session, manifest, String(manifest?.ask ?? ""));
      const bfe = await run(sql`INSERT INTO build_file (artifact_id, path, status, error, attempts, updated_ts) VALUES (${id}, ${path}, 'error', ${errMsg}, 1, ${Date.now()})
        ON CONFLICT(artifact_id, path) DO UPDATE SET status = 'error', error = excluded.error, attempts = build_file.attempts + 1, updated_ts = excluded.updated_ts`);
      if (!bfe.ok) console.error(`[build] build_file error row for ${path} was not written:`, bfe.error);
      // STATUS MUST DESCRIBE THE FAILURE. A blanket 502 made every ordinary build failure read in DevTools
      // as a gateway outage; clientStatusFor maps it honestly instead.
      return Response.json({ error: { message: errMsg, details: [APP_LEVEL_NOTE] }, path }, { status: clientStatusFor(e) });
    }
  }
  // ── ERROR INTAKE: the preview's runtime errors become a repair brief, automatically ──
  //
  // POST ?report_errors {artifactId, session, reports:[{message,kind,stack,props,causes,state}]}
  //
  // Each raw payload is resolved against the artifact's OWN stored source: every stack frame gets its
  // offending line with a caret, a window of context, the enclosing function and parameters, and the
  // identifiers each enclosing scope declares. The cross-file lint is folded in, so one brief carries
  // both the runtime failures and the static ones instead of the model seeing them a round apart.
  //
  // Rounds are counted per artifact and capped. An auto-repair loop with no ceiling is how a page with
  // one unfixable error spends a provider quota overnight.
  if (method === "POST" && url.searchParams.has("report_errors")) {
    const b = await readJsonBody(req);
    const id = Number(b.artifactId);
    const maxRounds = Math.max(1, Math.min(10, Number(b.maxRounds ?? 3)));
    if (!Number.isInteger(id)) return Response.json({ error: { message: "artifactId required" } }, { status: 400 });
    const lf = await listFiles(id);
    if (!lf) return Response.json({ error: { message: `artifact ${id} not found` } }, { status: 404 });

    const raw = Array.isArray(b.reports) ? b.reports.slice(0, 20) : [];
    const reports: ErrorReport[] = raw.map((r: any) => buildReport(r ?? {}, lf.files));
    const lint = lintArtifact(lf.files);
    const brief = formatRepairBrief(reports, lint);

    const key = `errors:${id}`;
    const prev = unwrap(await all("omni_state", sql`SELECT * FROM omni_state WHERE key = ${key}`), []) as any[];
    let round = 0;
    try { round = Number(JSON.parse(prev[0]?.value ?? "{}").round ?? 0); } catch { round = 0; }
    // A brief identical to the last one means the previous repair changed nothing that mattered; counting
    // it as a fresh round is what turns "retry" into "retry forever".
    let lastBrief = "";
    try { lastBrief = String(JSON.parse(prev[0]?.value ?? "{}").brief ?? ""); } catch { /* first report */ }
    const unchanged = brief !== "" && brief === lastBrief;
    const next = brief ? round + 1 : round;
    const exhausted = next > maxRounds;

    await run(sql`INSERT INTO omni_state (key, value, ts) VALUES (${key}, ${JSON.stringify({ round: next, brief, unchanged, errors: reports.length, lint: lint.length, at: Date.now() }).slice(0, 200_000)}, ${Date.now()})
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`).catch(() => {});

    return Response.json({
      artifactId: id,
      errors: reports.length,
      lint: lint.length,
      round: next,
      maxRounds,
      exhausted,
      unchanged,
      repairable: !!brief && !exhausted && !unchanged,
      files: reports.flatMap((r) => r.frames.filter((f) => f.resolved).map((f) => f.file)).filter((v, i, a) => a.indexOf(v) === i),
      brief,
    });
  }

  // ── SCHEDULED BUILD: the path that does NOT try to build an app in one response ──
  //
  // POST ?build_start {q, session, settings} -> enqueues `plan`, returns a job id immediately. Nothing is
  // built yet; the plan step fans out one `build` step per file, and those drain over many invocations.
  //
  // GET ?build_status&job=<id> -> runs a tick, THEN reports. The poll is the engine: each one claims and
  // executes whatever steps fit in its budget, so progress happens because the UI is watching, with the
  // cron val (scheduler-cron.ts) only needed to finish a job nobody is looking at. Claims are atomic
  // conditional UPDATEs, so overlapping polls cannot run the same step twice.
  // POST ?drain -> claim and run ONE step, then return. The smallest possible unit of server work, and
  // the reason bulk processing is real rather than nominal: each of these is its own invocation with its
  // own fresh clock, so N of them dispatched at once genuinely run at once. It takes no parameters and
  // returns no session data — there is nothing here to address, only the queue to advance — and it is
  // idempotent by construction, because claiming a step is an atomic conditional UPDATE.
  if (url.searchParams.has("drain")) {
    if (method !== "POST") return Response.json({ error: { message: "POST only" } }, { status: 405 });
    return Response.json(await drainOne());
  }

  // POST ?build_cancel {job} -> stop a job for real.
  //
  // The client's stop button used to flip a flag on the polling loop, which stopped the POLLING and
  // nothing else: the steps stayed queued and the interval val kept executing them, so "stop" meant
  // "stop watching", and a repair the user had stopped kept spending and kept writing. This marks every
  // unstarted step terminal and records the stop on the job, so the queue's own state says stopped too.
  if (method === "POST" && url.searchParams.has("build_cancel")) {
    let job = String(url.searchParams.get("job") ?? "");
    let reason = "stopped by the user";
    if (!job) {
      const b = await readJsonBody(req).catch(() => ({}) as any);
      job = String(b?.job ?? "");
      if (typeof b?.reason === "string" && b.reason.trim()) reason = b.reason.trim().slice(0, 200);
    }
    if (!job) return Response.json({ error: { message: "job required" } }, { status: 400 });
    return Response.json({ cancelled: true, ...(await stopJob(job, reason)) });
  }

  if (method === "POST" && url.searchParams.has("build_start")) {
    const b = await readJsonBody(req);
    const settings = normalizeSettings(b.settings ?? {});
    const session = String(b.session ?? "default"), ask = clean(String(b.q ?? ""));
    if (!ask) return Response.json({ error: { message: "empty ask" } }, { status: 400 });
    await ensureSession(session);
    const job = await startBuild(session, ask, settings);
    // Returning fast is the entire point of this route, so the tick budget is deliberately far too
    // short to run a design or plan step (both declare maxMs 30_000). The scheduler SKIPS a step that
    // cannot fit the current tick and leaves it ready - it used to fail() it, which cascaded and killed
    // the job this route had just created. Steps small enough to fit still drain here; the rest wait for
    // ?build_status or the interval val.
    await tick(T.fastTick).catch(() => {});
    return Response.json({ ...(await buildProgress(job)), scheduled: true }); // buildProgress already carries `job`
  }

  // GET ?requests&session=S -> every request this session has made, newest first, with what each one
  // actually became. "i keep asking for something and then the ai creates something completely
  // different" needs a place where the two can be put side by side; this is it. The record is the job
  // state that already exists (one row per job in omni_state), so nothing new is written and nothing can
  // fall out of sync with the build it describes.
  if (method === "GET" && url.searchParams.has("requests")) {
    const session = String(url.searchParams.get("session") ?? "");
    if (!session) return Response.json({ error: { message: "session required" } }, { status: 400 });
    // Job ids are `build:<session>:<suffix>` and job state is keyed `jobstate:<job>`. Session ids are
    // UUIDs, so they contain no LIKE wildcards to escape.
    const r = await all("omni_state", sql`SELECT key, value, ts FROM omni_state WHERE key LIKE ${"jobstate:build:" + session + ":%"} ORDER BY ts DESC LIMIT 50`);
    const rows = (r.ok ? r.value : []) as any[];
    const requests = rows.map((row) => {
      let st: any = null;
      try { st = JSON.parse(String(row.value)); } catch { return null; }
      if (!st) return null;
      return {
        job: String(row.key).replace(/^jobstate:/, ""),
        asked: String(st.ask ?? ""),               // VERBATIM. Never the design, never a summary.
        ts: Number(row.ts) || null,
        artifactId: st.artifactId ?? null,
        built: String(st.title ?? ""),
        files: (st.manifest?.files ?? []).map((f: any) => String(f.path)).filter(Boolean),
        complete: st.complete ?? null,
        missing: st.missing ?? [],
        repair: !!st.repair,
        // The only field that answers "did it build what I asked for", as opposed to "did it finish".
        conform: st.conform ?? null,
      };
    }).filter(Boolean);
    return Response.json({ session, requests });
  }

  // GET ?tasks&job=<id> -> the job's task graph alone, without running a tick. The status poll DRIVES
  // the queue, which makes it the wrong thing to call when you only want to look: a dashboard refreshing
  // every few seconds would be spending the model budget to render a table.
  if (method === "GET" && url.searchParams.has("tasks")) {
    const job = String(url.searchParams.get("job") ?? "");
    if (!job) return Response.json({ error: { message: "job required" } }, { status: 400 });
    return Response.json(await jobTasks(job));
  }

  if (method === "GET" && url.searchParams.has("build_status")) {
    const job = String(url.searchParams.get("job") ?? "");
    if (!job) return Response.json({ error: { message: "job required" } }, { status: 400 });
    // 40s against the ~60s kill: the remainder is the margin the scheduler needs to RECORD what it just
    // ran. Spending it is how a finished step gets marked ready again and repeats forever.
    // Was `await tick(T.pollTick)` — the poll DID the work, so twelve 18s steps shared one 60s
    // invocation and the queue drained one pollful at a time however wide the wave was. Now the poll
    // DISPATCHES: N concurrent ?drain requests, N separate invocations, N clocks. Same val, no new
    // deployments, and it falls back to the old in-process tick if the val cannot reach itself.
    const report = await driveQueue(req, url.origin, T.pollTick).catch((e) => ({ error: String(e?.message ?? e) }));
    // The task graph rides along with progress. "12 files, 3 built" does not say what the system is
    // doing right now or what is stuck behind what; the tasks do, and the poll is already paid for.
    // ONE read of the job's steps, two views of it. These were two concurrent SELECTs over the same
    // rows differing only in their column list — on the single most frequently called route in the app.
    const stepQ = await all("step", sql`SELECT id, kind, status, payload, needs, gate, priority, created, updated, started, error FROM step WHERE job = ${job} ORDER BY seq, id`);
    // A FAILED read is not an empty job. Passing [] on error would report a healthy, empty queue for a
    // job the database could not be asked about — the exact conflation that once left this scheduler
    // reporting ran:0 for its whole life. On error, fall through to the callers' own reads.
    const stepRows = stepQ.ok ? (stepQ.value as any[]) : undefined;
    const [pr, tk] = await Promise.all([buildProgress(job, stepRows), jobTasks(job, stepRows)]);
    return Response.json({ ...pr, tick: report, tasks: tk.tasks, durations: tk.durations, blocked: tk.blocked });
  }

  // ── build jobs: the orchestration state of a swarm build, persisted so a closed tab / dead network / reload can resume it ──
  // GET ?job=list&session=S → unfinished jobs; POST ?job {session, artifactId, state} → update status (manifest/files already
  // live in build_job/build_file — see ?plan and ?build_file above — so this no longer needs to carry done/failed arrays).
  //
  // Previously this was a single opaque JSON blob per job in omni_state (key "job:<session>:<artifactId>"), DELETED the
  // instant a build finished — so build_job/build_file (db.ts) exist specifically so "what got built, from what plan, in
  // what state" has a durable, queryable, joinable answer that survives past "done" instead of vanishing on completion.
  if (url.searchParams.has("job")) {
    if (method === "GET") {
      const session = String(url.searchParams.get("session") ?? "");
      const jobs = unwrap(await all("build_job", sql`SELECT * FROM build_job WHERE session = ${session} AND status != 'done' ORDER BY updated_ts DESC LIMIT 20`), []);
      const out: Record<string, unknown>[] = [];
      for (const j of jobs) {
        let manifest: any = null, manifestError: string | null = null;
        try { manifest = JSON.parse(j.manifest); } catch (e: any) { manifestError = `stored manifest is corrupt JSON: ${String(e?.message ?? e).slice(0, 200)}`; }
        // Previously a corrupt row was silently `continue`d past — the job vanished from the list with no
        // trace, so a client polling ?job=list had no way to know a build existed at all, let alone that it
        // needed attention. Surface it instead: the client can render an error state and offer to clear it
        // (e.g. by marking the job 'stopped' via ?job POST) rather than the build silently disappearing.
        if (!manifest) { out.push({ artifactId: j.artifact_id, manifest: null, manifestError, title: j.title, ask: j.ask, status: j.status, ts: j.updated_ts, done: [], failed: [] }); continue; }
        const files = unwrap(await all("build_file", sql`SELECT path, status FROM build_file WHERE artifact_id = ${j.artifact_id}`), []);
        out.push({
          artifactId: j.artifact_id, manifest, title: j.title, ask: j.ask, status: j.status, ts: j.updated_ts,
          done: files.filter((f: any) => f.status === "ok").map((f: any) => f.path),
          failed: files.filter((f: any) => f.status === "error" || f.status === "issues").map((f: any) => f.path),
        });
      }
      return Response.json({ jobs: out });
    }
    if (method === "POST") {
      const b = await readJsonBody(req);
      const session = String(b.session ?? ""), id = Number(b.artifactId), state = b.state ?? {};
      if (!session || !Number.isInteger(id)) return Response.json({ error: { message: "bad session/artifactId" } }, { status: 400 });
      // Previously any client-supplied string landed straight in build_job.status with no validation — a typo
      // or a future caller sending e.g. "complete" instead of "done" would silently create a status value
      // that every reader (checkResume's `status !== 'done'` filter, any future dashboard) doesn't recognize,
      // rather than failing loudly at the one place that writes it.
      const BUILD_STATUSES = new Set(["planned", "building", "integrating", "done", "stopped"]);
      const status = String(state.status ?? "building");
      if (!BUILD_STATUSES.has(status)) return Response.json({ error: { message: `bad status "${status}" — must be one of ${[...BUILD_STATUSES].join(", ")}` } }, { status: 400 });
      const title = String(state.title ?? ""), ask = String(state.ask ?? "").slice(0, 2000);
      await run(sql`UPDATE build_job SET status = ${status}, updated_ts = ${Date.now()},
          title = CASE WHEN ${title} = '' THEN title ELSE ${title} END,
          ask = CASE WHEN ${ask} = '' THEN ask ELSE ${ask} END
        WHERE artifact_id = ${id}`);
      return Response.json({ ok: true });
    }
  }
  return null;
}
