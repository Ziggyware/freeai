// REPAIR — the part of the work a BUILD does not have to do.
//
// The report that produced this file, verbatim: "Fix artifact #17 (Starfield Explorer). The preview
// console shows: Uncaught TypeError: THREE.WebGLRenderer is not a constructor (render.js:27). Find the
// root cause in the files, apply the smallest correct fix with update_artifact, and say what was wrong."
//
// What the system did instead: it turned the ask into a scheduled job whose `diagnose` step derived
// targets from the generic lint, queued whole-file REBUILDS of index.html, render.js and manifest.json,
// ran them with a prompt that rewrites a file from its purpose line, reported "repair — 12/12 files,
// queue drained", and left the const conformance judge to answer "THIS IS NOT WHAT YOU ASKED FOR". Three
// defects, and each one has a home here:
//
//   1. ROUTING. A one-file fix with a file and a line in it is not a build and does not need a job; it is
//      a read + one small edit, which the chat turn's own tools (read_artifact / update_artifact) perform
//      better than any scheduler can. Scheduling it anyway is what "it just created a scheduled job
//      instead of making the fix" is.
//   2. TARGETING. The files to touch are in the ASK — the path, the line, the stack — and the lint is
//      only a fallback. Deriving targets from lint when the user already named the file is how a repair
//      rewrote manifest.json while leaving render.js semantically unchanged.
//   3. VERIFICATION. A repair is not "the same file list, rewritten". Its goal is that THE REPORTED
//      ERROR IS GONE and the named files actually CHANGED, and neither of those was checked by anything.
//
// This module is deliberately pure: no db, no model, no network. Every rule that decides what to touch,
// what to leave alone, and whether a repair did anything is therefore testable in isolation, which is
// what lets the loop's stop condition be a fact rather than a hope.

/** How many repair rounds the durable job runs before it reports failure instead of spending more. */
export const MAX_REPAIR_ROUNDS = 4;

/** PLAN METADATA: written once by the planner, never the cause of a runtime defect, and destroyed by a
 *  model rewrite (it is JSON the model would have to reproduce byte-for-byte from a summary). A repair
 *  must not touch it unless the user names it explicitly. `manifest.json` is the exact file the observed
 *  job rebuilt while the bug stayed in render.js. */
const METADATA_NAMES = /(^|\/)(manifest\.json|package(?:-lock)?\.json|tsconfig\.json|\.gitignore|\.ds_store)$/i;
const METADATA_EXT = /\.(?:md|txt|lock|log|csv)$/i;
export const isMetadataPath = (p: string) => METADATA_NAMES.test(String(p)) || METADATA_EXT.test(String(p));

const SOURCE_EXT = /\.(?:m?js|jsx|ts|tsx|css|html?|svg|json|glsl|frag|vert|wgsl|mjs|cjs)$/i;
/** A file a model can plausibly fix: source or markup, not documentation or plan metadata. */
export const isSourcePath = (p: string) => SOURCE_EXT.test(String(p)) && !isMetadataPath(p);

/** Content identity for "did this file actually change". FNV-1a plus length: two different contents that
 *  collide need the same length AND the same rolling hash, and a same-length no-op edit (whitespace,
 *  reordering) still changes the hash. Not cryptographic — it only ever compares one file to its own
 *  earlier self. */
export function fingerprint(content: unknown): string {
  const t = String(content ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + ":" + t.length;
}

const EXT = "m?js|jsx|ts|tsx|css|html?|json|svg|md|txt|glsl|frag|vert|wgsl|csv";
/** `render.js`, `./src/app.js`, `/artifact/17/render.js`, `file:///x/render.js:27:5`, `render.js:27`. */
const PATH_RX = new RegExp(`(?:^|[\\s"'\`(\\[=,>])((?:[\\w.@~-]+\\/)*[\\w.@~-]+\\.(?:${EXT}))(?::(\\d{1,6}))?(?::(\\d{1,6}))?(?![\\w.])`, "gi");
/** Stack frames inside the caret text: `at render (render.js:27:5)`, `at render.js:27:5`. */
const FRAME_RX = new RegExp(`\\bat\\s+(?:[\\w$<>.[\\]\\s]*?\\()?((?:[\\w.@~-]+\\/)*[\\w.@~-]+\\.(?:${EXT})):(\\d{1,6})(?::(\\d{1,6}))?`, "gi");

/** Normalize a path as pasted from a console: absolute, artifact-relative, or `./`.
 *
 *  The path is NOT truncated to its last segments: artifacts may legitimately nest (`src/render.js`),
 *  and shortening a mention is how a fix lands in a same-named file in the wrong directory. */
export function normalizeMention(raw: string): string {
  let p = String(raw ?? "").trim().replace(/^["'`(]+|["'`)]+$/g, "").replace(/\\/g, "/");
  const art = /\/artifact\/\d+\/(.+)$/.exec(p);
  if (art) p = art[1];
  else if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\/[^/]*\/?/i, "");
  else if (/^[a-z]+:\/\//i.test(p)) p = p.replace(/^[a-z]+:\/\/[^/]*\/?/i, "");
  const tail = p.replace(/^\/+/, "").replace(/^(?:\.\/)+/, "").split("/").filter((s) => s && s !== "." && s !== "..");
  return tail.join("/").slice(0, 200);
}

/** Resolve a mention against the files that actually exist.
 *
 *  A console says `render.js`; the artifact may store it as `src/render.js`. Matching by (1) exact path,
 *  (2) path suffix, (3) unique basename is what keeps a fix pointed at the file the user meant — and it
 *  returns null rather than guessing when two files share a basename, so an ambiguity is reported
 *  instead of being resolved into the wrong file. */
export function matchKnown(mention: string, known: string[]): string | null {
  const p = normalizeMention(mention);
  if (!p) return null;
  const paths = known.map(normalizeMention);
  const exact = paths.find((k) => k === p);
  if (exact) return exact;
  const suffix = paths.filter((k) => k.endsWith("/" + p));
  if (suffix.length === 1) return suffix[0];
  const base = p.split("/").pop()!;
  const byBase = paths.filter((k) => k.split("/").pop() === base);
  return byBase.length === 1 ? byBase[0] : null;
}

export type RepairAsk = {
  /** Files the ask names, deduped, in order of first mention. */
  paths: string[];
  /** file -> 1-based line, from `render.js:27` or a stack frame. */
  lines: Record<string, number>;
  /** The console/stack evidence in the ask, each line capped, most specific first. */
  errors: string[];
  /** The ask asks for a whole-project repair ("fix all the errors", "keep going until it works"). */
  broad: boolean;
  /** One file (or the focused file) and nothing broad: a read plus one small edit, run inline. */
  surgical: boolean;
  /** The file the workbench has open, when the ask names none. */
  focus: string | null;
};

/** The error-ish lines of an ask, trimmed to the part that carries the evidence.
 *
 *  An ask is usually ONE line ("Fix #17 — Uncaught TypeError: ... (render.js:27)"), so taking the whole
 *  line would hand a builder the user's politeness along with the fault. Slice from just before the
 *  first error token instead: the fault text, the file and the line all survive, the preamble does not. */
export function repairEvidence(text: string, max = 6): string[] {
  const RX = /\b(uncaught|typeerror|referenceerror|syntaxerror|rangeerror|error|exception|failed|refused|cannot read|is not a (?:constructor|function)|is not defined|not a function|timeout)\b/i;
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = RX.exec(line) ?? /\bat\s+[\w$<>.[\]\s]*\(?/.exec(line);
    if (!m) continue;
    if (out.some((x) => line.includes(x))) continue;
    const pre = line.slice(0, m.index);
    const cut = Math.max(pre.lastIndexOf(". "), pre.lastIndexOf("; "));
    const from = cut >= 0 && m.index - cut <= 240 ? cut + 2 : Math.max(0, m.index - 60);
    let piece = line.slice(from);
    if (from > 0 && cut < 0) piece = piece.replace(/^\S+\s+/, ""); // never start mid-word
    out.push(piece.slice(0, 400));
    if (out.length >= max) break;
  }
  return out;
}

export function parseRepairAsk(text: string, focusFile = ""): RepairAsk {
  const t = String(text ?? "");
  const paths: string[] = [];
  const lines: Record<string, number> = {};
  const note = (p: string, line?: number) => {
    const path = normalizeMention(p);
    if (!path || !SOURCE_EXT.test(path)) return;
    if (!paths.includes(path)) paths.push(path);
    const ln = Number(line);
    if (Number.isInteger(ln) && ln > 0 && lines[path] === undefined) lines[path] = ln;
  };
  for (const m of t.matchAll(FRAME_RX)) note(m[1], Number(m[2]));
  for (const m of t.matchAll(PATH_RX)) note(m[1], m[2] !== undefined ? Number(m[2]) : undefined);

  const broad = /\b(?:all|every|entire|whole)\s+(?:the\s+)?(?:files?|errors?|bugs?|app|application|project|codebase|site)\b|\bfix\s+everything\b|\bkeep\s+(?:going|working|fixing|at\s+it)\b|\buntil\b[^.\n]{0,40}\b(?:fix|work|pass|clean)\b|\b(?:rewrite|rebuild|recreate|redo)\b/i.test(t);
  const focus = focusFile ? normalizeMention(focusFile) : null;
  const candidates = paths.length ? paths : (focus ? [focus] : []);
  return { paths, lines, errors: repairEvidence(t), broad, surgical: !broad && candidates.length <= 1, focus };
}

export type Edit = { find: string; replace: string };
export type ApplyResult = { content: string; applied: number; failed: string[] };

/** Apply find→replace edits with `update_artifact`'s exact semantics: every `find` must occur exactly
 *  once. A find that is absent, or ambiguous, is reported and skipped — it never guesses. */
export function applyEdits(content: string, edits: Edit[]): ApplyResult {
  let cur = String(content ?? "");
  let applied = 0;
  const failed: string[] = [];
  for (const e of Array.isArray(edits) ? edits : []) {
    const find = typeof e?.find === "string" ? e.find : "";
    const replace = typeof e?.replace === "string" ? e.replace : "";
    if (!find) { failed.push("an edit had no `find` text"); continue; }
    const n = cur.split(find).length - 1;
    if (n !== 1) { failed.push(`find text ${n === 0 ? "not present" : `occurs ${n}× — make it unique`}: "${find.slice(0, 60)}"`); continue; }
    cur = cur.replace(find, replace);
    applied++;
  }
  return { content: cur, applied, failed };
}

/** Pull the JSON object out of a model reply that may carry prose or a fence around it. */
export function parseModelJson(raw: string): any | null {
  const t = String(raw ?? "");
  const fenced = /```[\w.+-]*\s*\n([\s\S]*?)\n```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export type RepairPick = {
  /** Files the repair will touch, in the order the ask named them (or by severity when derived). */
  targets: string[];
  /** file -> what to fix there. The builder prompt gets these verbatim. */
  findings: Record<string, string[]>;
  /** Files with defects the ask did not ask about. Named in the report, deliberately NOT rebuilt. */
  untouched: string[];
  /** The file the ask was really about, when one is named: the proof of a fix lives here. */
  primary: string | null;
  /** True when the ask named the targets — i.e. the scope is the user's, not the lint's. */
  scopedToAsk: boolean;
  /** Mentioned files that do not exist in the artifact yet. */
  absent: string[];
};

/** WHICH FILES A REPAIR TOUCHES — the user's answer if they gave one, the lint's only as a fallback.
 *
 *  The rules, in priority order:
 *    1. Every file the ask names is a target, existing or not. A named file the artifact lacks is still
 *       the right target: the page loads it, that is the 404, and the repair is to write it.
 *    2. A named file is targeted EVEN WHEN THE LINT IS SILENT ABOUT IT. A runtime TypeError is invisible
 *       to a static lint; "no findings" is not "no defect", and treating it as one is how the observed
 *       repair skipped the file the user pointed at.
 *    3. When the ask names nothing, derive from lint and missing references — but never from plan
 *       metadata (rule: metadata is written by the planner, is not a defect source, and a model rewrite
 *       destroys it).
 *    4. Files with problems OUTSIDE the named scope are reported, not rebuilt. A one-file fix that
 *       rewrites four files is the regression this module exists to prevent. */
export function pickRepairTargets(o: {
  ask: RepairAsk;
  askText?: string;
  known: string[];
  lint: string[];
  missing: { path: string; referrers: string[] }[];
}): RepairPick {
  const known = new Set(o.known.map((p) => normalizeMention(p)));
  const knownList = o.known.map((p) => normalizeMention(p));
  const lintBy = new Map<string, string[]>();
  for (const issue of o.lint) {
    const m = /^([^\s:]+):\s*(.+)$/.exec(String(issue ?? ""));
    if (!m) continue;
    const p = normalizeMention(m[1]);
    const arr = lintBy.get(p);
    if (arr) arr.push(m[2]); else lintBy.set(p, [m[2]]);
  }
  const missingBy = new Map<string, string[]>();
  for (const a of o.missing) missingBy.set(normalizeMention(a.path), a.referrers.map(String));

  const findings: Record<string, string[]> = {};
  const note = (p: string, msg: string) => { (findings[p] ??= []).push(msg); };
  /** The reported line for a path, whichever spelling the ask used (`render.js` vs `src/render.js`). */
  const lineFor = (path: string): number | undefined => {
    for (const [mention, ln] of Object.entries(o.ask.lines)) {
      const hit = matchKnown(mention, knownList);
      if (hit === path || normalizeMention(mention) === path) return ln;
    }
    return undefined;
  };
  // A mention resolves to the REAL path when the artifact has it (`render.js` → `src/render.js`), and is
  // kept verbatim when it does not, because that absence is the fix for a 404.
  const mentions = o.ask.paths.length ? o.ask.paths : (o.ask.focus ? [o.ask.focus] : []);
  const named: string[] = [];
  for (const m of mentions) {
    const hit = matchKnown(m, knownList) ?? normalizeMention(m);
    if (hit && !named.includes(hit)) named.push(hit);
  }
  const targets: string[] = [];
  const absent: string[] = [];

  if (named.length) {
    for (const p of named) {
      if (targets.includes(p)) continue;
      const exists = known.has(p);
      if (!exists) absent.push(p);
      targets.push(p);
      const miss = missingBy.get(p);
      if (miss?.length) note(p, `this file does not exist but ${miss.join(", ")} loads it — that is the 404; write the real file`);
      else if (!exists) note(p, "this file does not exist in the artifact — write the file the page expects");
      const ln = lineFor(p);
      if (ln) note(p, `the reported error points at line ${ln} of this file — inspect that line and its enclosing scope first`);
      for (const e of o.ask.errors) note(p, `reported error: ${e}`);
      const lint = lintBy.get(p) ?? [];
      for (const l of lint.slice(0, 8)) note(p, l);
      if (exists && !lint.length && !miss?.length) {
        note(p, "this file has NO static defect — the runtime error is the evidence. Find the root cause by reading it; do not rewrite it wholesale.");
      }
    }
  } else {
    // Derived scope: real defects, worst first, metadata excluded.
    const counts = new Map<string, number>();
    for (const p of lintBy.keys()) if (known.has(p) && isSourcePath(p)) counts.set(p, (counts.get(p) ?? 0) + (lintBy.get(p)?.length ?? 0));
    const absentDerived = [...missingBy.keys()].filter((p) => !known.has(p) && isSourcePath(p));
    for (const p of [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 6)) {
      targets.push(p);
      for (const l of (lintBy.get(p) ?? []).slice(0, 8)) note(p, l);
    }
    for (const p of absentDerived.slice(0, 6)) {
      if (targets.includes(p)) continue;
      targets.push(p);
      absent.push(p);
      note(p, `this file does not exist but ${(missingBy.get(p) ?? []).join(", ")} loads it — that is the 404; write the real file`);
    }
  }

  // Defects outside the named scope: visible, untouched.
  const untouched = [...lintBy.keys()].filter((p) => known.has(p) && !targets.includes(p)).slice(0, 12);
  for (const p of untouched) note(p, `(not in the requested scope — reported only, not rebuilt) ${(lintBy.get(p) ?? [])[0] ?? ""}`.trim());
  for (const p of targets) if (!findings[p]?.length) note(p, "inspect this file against the reported error and fix the root cause");

  const primary = targets.find((p) => lineFor(p) !== undefined) ?? named[0] ?? targets[0] ?? null;
  return { targets, findings, untouched, primary, scopedToAsk: named.length > 0, absent };
}

/** The one-line goal a repair is judged against, used verbatim in the card, the job state and the
 *  conformance prompt so all three describe the same thing. */
export function repairGoal(askText: string, pick: RepairPick): string {
  const named = pick.scopedToAsk ? pick.targets.join(", ") : (pick.primary ?? pick.targets.join(", "));
  const first = repairEvidence(askText, 1)[0] ?? String(askText ?? "").trim().slice(0, 200);
  return `${first}${named ? ` — in ${named}` : ""}`.slice(0, 400);
}

/** THE ARTIFACT'S OWN FILES THAT A FILE IMPORTS, RESOLVED FROM ITS CONTENT.
 *
 *  A repair cannot use the plan's `imports` field: `diagnose` replaces the manifest with one built from the
 *  files that exist, whose entries carry no dependency data (and an artifact can exist without a manifest
 *  at all). `render.js` importing a three.js shim is exactly the case where the defect is in one file and
 *  the cause is in another, and a model that cannot see the shim guesses at its shape — which is how a
 *  "WebGLRenderer is not a constructor" gets "fixed" by editing the line that calls it. This resolves the
 *  file's local (non-bare) specifiers against the artifact's real paths, one hop, so the repair prompt can
 *  hand over what the file actually imports. */
export function localImports(content: string, known: string[], selfPath: string): string[] {
  const have = new Set(known.map((p) => normalizeMention(p)));
  const dir = selfPath.includes("/") ? selfPath.slice(0, selfPath.lastIndexOf("/")) : "";
  const out: string[] = [];
  const specifiers: string[] = [];
  const rxFrom = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"`()]*?\sfrom\s*)?["']([^"']+)["']/g;
  const rxDyn = /\bimport\s*\(\s*["']([^"']+)["']/g;
  for (const rx of [rxFrom, rxDyn]) for (const m of String(content ?? "").matchAll(rx)) specifiers.push(m[1]);
  for (const spec of specifiers) {
    const clean = String(spec).split("?")[0].split("#")[0];
    if (!/^[.\/]/.test(clean)) continue;                 // bare specifier: a CDN import, not an artifact file
    const raw = normalizeMention(clean);
    const joined = normalizeMention(dir ? dir + "/" + raw : raw);
    const hit = have.has(joined) ? joined : have.has(raw) ? raw : null;
    if (!hit || hit === selfPath || out.includes(hit)) continue;
    out.push(hit);
  }
  return out;
}

/** Does a repaired file still look like the broken one? Used for the "no change" verdict.
 *
 *  Identical content after a repair round means the round did nothing, regardless of what the model
 *  claimed. That is a FACT about the artifact, and it is the only available one — the reported error is a
 *  browser observation this system cannot re-observe. */
export function unchanged(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== undefined && fingerprint(before) === fingerprint(after);
}

/** A repair ask is "structural" when one inline turn cannot finish it: several files, a whole-project
 *  phrase, or an explicit request to keep going until everything is fixed. */
export function isStructuralRepair(ask: RepairAsk): boolean {
  return ask.broad || ask.paths.length > 1;
}
