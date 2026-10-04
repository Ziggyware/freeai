// Multi-file artifacts: an `artifact` row (title, kind, index content) plus
// `artifact_file` rows. Served path-style at /artifact/<id>/<path> so relative
// <script src="app.js"> and fetch("data.json") resolve inside the artifact.
import { all, Err, Ok, one, type Result, type Row, run, sql, type DbError } from "./db.ts";
import { blankCommentsAndRegex, blankNonCode, commentsOnly } from "./errors.ts";

export type ArtFile = { path: string; content: string };
export const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  // TypeScript/JSX are served as JavaScript so they RENDER (editor, full view, fetch) rather than being
  // offered as an octet-stream download. Serving them does not make them RUNNABLE - no browser executes
  // type annotations or JSX - which is what lintUncompiledSources exists to say out loud.
  ts: "text/javascript; charset=utf-8", tsx: "text/javascript; charset=utf-8", jsx: "text/javascript; charset=utf-8", mts: "text/javascript; charset=utf-8", cts: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml; charset=utf-8", md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", wgsl: "text/plain; charset=utf-8", glsl: "text/plain; charset=utf-8", frag: "text/plain; charset=utf-8", vert: "text/plain; charset=utf-8", vs: "text/plain; charset=utf-8", fs: "text/plain; charset=utf-8", xml: "application/xml; charset=utf-8", webmanifest: "application/manifest+json", ico: "image/x-icon", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
export const mimeFor = (path: string) => MIME[(path.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
export const safePath = (p: unknown) => String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\.(\/|$)/g, "").slice(0, 200);
const indexOf = (kind: string) => kind === "html" ? "index.html" : kind === "svg" ? "index.svg" : "index.md";

// Identity is always the numeric id, never (session, title) — two different builds in the same
// session routinely land on the same or a reused title ("Todo App", "Dashboard", a model repeating
// its own earlier title), and a title-keyed upsert would silently overwrite an unrelated, earlier
// artifact's content with no versioning and no warning. Pass `id` to update that exact row (and
// verify it belongs to `session`, so a stale/foreign id can't be used to edit another session's
// artifact); omit it to always create a brand-new row, even if the title matches an existing one.
export async function upsertArtifact(session: string, title: string, kind: Row<"artifact">["kind"], content: string, id?: number | null): Promise<Result<Row<"artifact">, DbError>> {
  const ts = Date.now();
  if (id) {
    const w = await run(sql`UPDATE artifact SET title = ${title}, kind = ${kind}, content = ${content}, ts = ${ts} WHERE id = ${id} AND session = ${session}`);
    if (!w.ok) return w;
    if (w.value.rowsAffected === 0) return Err<DbError>("UNKNOWN"); // id didn't exist, or belongs to a different session — never silently fall through to creating a new row here
    const r = await one("artifact", sql`SELECT * FROM artifact WHERE id = ${id}`);
    if (!r.ok) return r;
    return r.value ? Ok(r.value) : Err<DbError>("UNKNOWN");
  }
  const w = await run(sql`INSERT INTO artifact (session, title, kind, content, ts) VALUES (${session}, ${title}, ${kind}, ${content}, ${ts})`);
  if (!w.ok) return w;
  if (w.value.lastInsertRowid === undefined) return Err<DbError>("UNKNOWN");
  const r = await one("artifact", sql`SELECT * FROM artifact WHERE id = ${Number(w.value.lastInsertRowid)}`);
  if (!r.ok) return r;
  return r.value ? Ok(r.value) : Err<DbError>("UNKNOWN");
}

export const artifactById = (id: number) => one("artifact", sql`SELECT * FROM artifact WHERE id = ${id}`);

export async function writeFile(id: number, path: string, content: string) {
  const p = safePath(path);
  const a = await artifactById(id);
  if (!a.ok || !a.value) return Err<DbError>("UNKNOWN");
  if (p === indexOf(a.value.kind)) await run(sql`UPDATE artifact SET content = ${content}, ts = ${Date.now()} WHERE id = ${id}`);
  return run(sql`INSERT INTO artifact_file (artifact_id, path, content, ts) VALUES (${id}, ${p}, ${content}, ${Date.now()})
    ON CONFLICT(artifact_id, path) DO UPDATE SET content = excluded.content, ts = excluded.ts`);
}

/** All files, with the index synthesized from artifact.content when no row exists for it. */
export async function listFiles(id: number): Promise<{ artifact: Row<"artifact">; files: ArtFile[] } | null> {
  const a = await artifactById(id);
  if (!a.ok || !a.value) return null;
  const r = await all("artifact_file", sql`SELECT path, content FROM artifact_file WHERE artifact_id = ${id} ORDER BY path`);
  const files: ArtFile[] = r.ok ? (r.value as ArtFile[]) : [];
  const idx = indexOf(a.value.kind);
  if (!files.some((f) => f.path === idx)) files.unshift({ path: idx, content: a.value.content });
  return { artifact: a.value, files };
}

export async function readFile(id: number, path: string): Promise<{ content: string; kind: string } | null> {
  const p = safePath(path);
  const a = await artifactById(id);
  if (!a.ok || !a.value) return null;
  if (!p || p === indexOf(a.value.kind) || p === "index.html") {
    const f = await one("artifact_file", sql`SELECT * FROM artifact_file WHERE artifact_id = ${id} AND path = ${p || indexOf(a.value.kind)}`);
    return { content: f.ok && f.value ? f.value.content : a.value.content, kind: a.value.kind };
  }
  const f = await one("artifact_file", sql`SELECT * FROM artifact_file WHERE artifact_id = ${id} AND path = ${p}`);
  return f.ok && f.value ? { content: f.value.content, kind: a.value.kind } : null;
}

/** Create/update with optional extra files. Pass `id` to update an existing artifact by its real
 *  identity (see upsertArtifact) instead of creating a new row. Returns the row and the file list
 *  written — or an error if the entry-file write didn't actually confirm, so a caller can no longer
 *  get `ok:true` back for an artifact whose index file failed to persist. */
export async function saveArtifact(session: string, title: string, kind: Row<"artifact">["kind"], content: string, files: ArtFile[] = [], id?: number | null) {
  const r = await upsertArtifact(session, title, kind, content, id);
  if (!r.ok) return r;
  const idx = indexOf(kind);
  const fw = await run(sql`INSERT INTO artifact_file (artifact_id, path, content, ts) VALUES (${r.value.id}, ${idx}, ${content}, ${Date.now()})
    ON CONFLICT(artifact_id, path) DO UPDATE SET content = excluded.content, ts = excluded.ts`);
  if (!fw.ok) return fw; // was previously discarded: create_artifact/update_artifact reported ok:true even when the entry file never actually saved
  for (const f of files) if (f?.path && typeof f.content === "string" && safePath(f.path) !== idx) await writeFile(r.value.id, f.path, f.content);
  return r;
}

export async function deleteFile(id: number, path: string, dir = false) {
  const p = safePath(path);
  if (!p || p === "index.html") return Err<DbError>("UNKNOWN");
  if (dir) { const like = p.replace(/\/$/, "") + "/%"; return run(sql`DELETE FROM artifact_file WHERE artifact_id = ${id} AND path LIKE ${like}`); }
  return run(sql`DELETE FROM artifact_file WHERE artifact_id = ${id} AND path = ${p}`);
}

/** Batch write (zip import, swarm builders). Creates the artifact when `id` is absent. Binary files arrive as data: URLs and are stored verbatim. */
export async function saveMany(session: string, id: number | null, title: string, files: ArtFile[]): Promise<{ id: number; written: string[]; issues: string[] } | null> {
  // size guard: the val's SQLite quota is the real ceiling (10 MB free) — refuse single files > 3 MB and batches > 12 MB instead of failing mid-write
  const clean = files.filter((f) => f && typeof f.path === "string" && typeof f.content === "string" && safePath(f.path) && f.content.length <= 3_000_000).slice(0, 400);
  if (clean.reduce((n, f) => n + f.content.length, 0) > 12_000_000) return null;
  let aid = id;
  if (!aid) {
    const idx = clean.find((f) => /^index\.html?$/.test(safePath(f.path))) ?? clean.find((f) => /\.html?$/.test(f.path));
    const r = await saveArtifact(session, title || "Imported", "html", idx?.content ?? "<!doctype html><html><body></body></html>", []);
    if (!r.ok) return null;
    aid = r.value.id;
  }
  const written: string[] = [];
  // Was one sequential round trip per file: a 12-file build paid 12 network hops in a row, inside a
  // step already bounded by its lease. The writes are independent — different primary keys, no ordering
  // between them — so they overlap. Concurrency is capped because the point is to stop paying latency
  // serially, not to open an unbounded number of connections to the same database.
  const WRITE_CONCURRENCY = 6;
  for (let i = 0; i < clean.length; i += WRITE_CONCURRENCY) {
    const batch = clean.slice(i, i + WRITE_CONCURRENCY);
    const results = await Promise.all(batch.map((f) => writeFile(aid!, f.path, f.content)));
    results.forEach((w, n) => { if (w.ok) written.push(safePath(batch[n].path)); });
  }
  const all = await listFiles(aid);
  return { id: aid, written, issues: all ? lintArtifact(all.files) : [] };
}

/** ES-module → script so `new Function` can parse it: drop import statements (multi-line too), `export {…}` lists, and `export` keywords. */
export function stripModuleSyntax(src: string): string {
  // The {0,600} bounds are not cosmetic. Unbounded `[\s\S]*?` with /m makes every line starting with the
  // word `import` that never reaches a matching from-clause scan to end of file before failing, which is
  // quadratic in file size: measured 10ms -> 43ms -> 234ms as input doubled from 42KB to 171KB. Generated
  // files are small enough today that this never reached the invocation kill, but the curve only goes one
  // way. 600 characters is far longer than any real import or export list, so nothing legitimate stops
  // matching; a pathological line now fails after 600 characters instead of after the whole file.
  return src.replace(/^\s*import\s[\s\S]{0,600}?from\s*["'][^"']+["']\s*;?/gm, "").replace(/^\s*import\s*["'][^"']+["']\s*;?/gm, "")
    .replace(/^\s*export\s*\{[\s\S]{0,600}?\}\s*(from\s*["'][^"']+["'])?\s*;?/gm, "").replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");
}
/** Static checks the model gets back after every write: dangling relative refs, JS syntax errors, external resources the CSP will block. */
export function lintArtifact(files: ArtFile[]): string[] {
  const issues: string[] = [];
  const have = new Set(files.map((f) => f.path));
  for (const f of files) {
    if (/\.html?$/.test(f.path)) {
      for (const m of f.content.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi)) {
        const ref = m[1].trim();
        if (/^(https?:)?\/\//i.test(ref)) { issues.push(`${f.path}: external resource "${ref.slice(0, 60)}" is an external URL — blocked in the sandbox and absent offline; vendor it as a file or inline it`); continue; }
        if (/^(data:|blob:|mailto:|javascript:|#)/i.test(ref)) continue;
        const rel = safePath(ref.replace(/^\.\//, ""));
        if (rel && !have.has(rel)) issues.push(`${f.path}: references "${ref}" but no such file exists (files: ${[...have].join(", ")})`);
      }
    }
    if (f.content.startsWith("data:")) continue; // binary
    if (/\.m?js$/.test(f.path)) {
      try { new Function(stripModuleSyntax(f.content)); }
      catch (e) { issues.push(`${f.path}: JS syntax error — ${(e as Error).message}`); }
    }
    if (/\.json$/.test(f.path)) { try { JSON.parse(f.content); } catch (e) { issues.push(`${f.path}: invalid JSON — ${(e as Error).message}`); } }
  }
  issues.push(...lintFileKind(files));
  issues.push(...lintModuleGraph(files));
  issues.push(...lintPlaceholders(files));
  issues.push(...lintModuleLoading(files));
  issues.push(...lintUnresolvedCalls(files));
  issues.push(...lintUncompiledSources(files));
  issues.push(...lintPortability(files));
  return issues.slice(0, 20);
}

/** Quality report against the virtuoso rubric. Heuristic and deliberately demanding: the user's standing rule is that a
 *  "basic" artifact is a failed artifact. Returned as `quality` (separate from `issues`), fed to the finish gate for
 *  app-scale asks and to the completion audit. Each string is an instruction the model can act on. */
export const APP_RX = /\b(app|application|game|editor|dashboard|simulat\w*|tool|ide|player|visuali[sz]\w*|engine|synth\w*|tracker|planner|studio|workbench|console|explorer|builder|designer|sequencer|daw|calculator|clone)\b/i;
export function qualityReport(files: ArtFile[]): string[] {
  const out: string[] = [];
  // `text()` below is called ~15 times in this function (once per rubric check); it used to re-filter and
  // re-join every file's content on EACH call — O(files × total chars × 15) instead of O(files × total chars)
  // — for a check that always filters and joins the exact same file set. Computed once here instead.
  const joined = files.filter((f) => !f.content.startsWith("data:")).map((f) => f.content).join("\n");
  const text = (rx: RegExp) => joined.match(rx);
  const code = files.filter((f) => /\.(m?js|html?)$/i.test(f.path) && !f.content.startsWith("data:"));
  const css = files.filter((f) => /\.css$/i.test(f.path)).map((f) => f.content).join("\n") + files.filter((f) => /\.html?$/i.test(f.path)).map((f) => (f.content.match(/<style[\s\S]*?<\/style>/gi) ?? []).join("\n")).join("\n");
  const lines = files.filter((f) => !f.content.startsWith("data:")).reduce((n, f) => n + f.content.split("\n").length, 0);
  const has = (rx: RegExp) => !!text(rx);
  if (files.length < 3) out.push(`scale: ${files.length} file(s) — split into index.html, a stylesheet, and at least one .js module so the app is editable`);
  if (!files.some((f) => /^readme\.md$/i.test(f.path))) out.push("README.md missing — list the features, controls, how to run, and the file map");
  else { const n = (files.find((f) => /^readme\.md$/i.test(f.path))!.content.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length; if (n < 10) out.push(`README.md lists ${n} bullet items — enumerate ≥ 10 implemented user-facing features and the keyboard shortcuts`); }
  if (has(/<canvas\b/i) && !has(/devicePixelRatio/)) out.push("canvas is not scaled by devicePixelRatio — blurry on every HiDPI screen; size the backing store by dpr and ctx.scale/viewport accordingly");
  if (!has(/ResizeObserver|addEventListener\(\s*["']resize["']/)) out.push("no resize handling — add a ResizeObserver (or resize listener) that relayouts/rescales");
  if (has(/requestAnimationFrame/) && !has(/visibilitychange|document\.hidden/)) out.push("animation loop never pauses when the tab is hidden — handle visibilitychange and use delta time");
  if (!has(/keydown|keyup/)) out.push("no keyboard input — add a shortcut map (documented in-app) and keyboard operability for every primary action");
  if (!has(/pointer(?:down|move|up)|touchstart|touchmove/)) out.push("no pointer/touch input handling — use pointer events so mouse, pen and touch all work");
  if (!has(/localStorage|indexedDB|IDBDatabase/)) out.push("no persistence — persist user state with a versioned schema (schemaVersion + migration) behind try/catch with an in-memory fallback");
  else if (!has(/schemaVersion|SCHEMA_VERSION|version\s*:\s*\d|migrat/i)) out.push("persistence has no schema version/migration — add one so stored state survives upgrades");
  if (!has(/\bundo\b/i) && has(/input|change|drag|edit|delete|remove/i) && code.length > 1) out.push("the user edits data but there is no undo/redo — add a command stack (or state snapshots) with ⌘Z/⇧⌘Z");
  if (!/--[\w-]+\s*:/.test(css)) out.push("no design tokens — define CSS custom properties for color, spacing, type scale, radius and motion, and use them everywhere");
  if (!/prefers-color-scheme|data-theme|\.dark\b/.test(css)) out.push("no theme handling — dark default with prefers-color-scheme (or a toggle) via the tokens");
  if (!/@media|clamp\(|minmax\(|container/.test(css)) out.push("layout is not responsive — media/container queries or fluid sizing (clamp, minmax)");
  if (!/transition|animation|@keyframes/.test(css)) out.push("no motion — add ≤ 200 ms transitions on state changes and respect prefers-reduced-motion");
  if (!has(/aria-|role=/)) out.push("no ARIA — label icon buttons, set roles/live regions, keep visible focus rings");
  if (!has(/empty|no data|nothing (?:here|yet)|get started/i)) out.push("no empty state — show a designed empty/first-run state with a call to action");
  if (!has(/toast|notif|snackbar|status/i)) out.push("no outcome feedback — add a toast/status system for actions, errors and saves");
  if (!has(/help|about|shortcuts|\?\s*<\/button>/i)) out.push("no in-app help — add a help/about panel listing controls and shortcuts");
  if (has(/\b(?:alert|prompt|confirm)\(/)) out.push("uses alert/prompt/confirm — replace with in-app dialogs");
  if (!has(/try\s*\{/)) out.push("no error handling at all — every async/IO path needs a catch with user-visible recovery");
  if (has(/\bfetch\(|await |\.then\(/) && !has(/catch/)) out.push("async code without catch — add error paths with user-visible recovery");
  const logs = (text(/console\.log\(/g) ?? []).length; if (logs > 3) out.push(`${logs} console.log calls in shipped code — replace with a leveled logger or remove`);
  if (has(/<img\b[^>]*src=["']https?:/i)) out.push("remote images — inline SVG or ship assets as files");
  if (!has(/<svg\b|<path\b/i)) out.push("no iconography — use inline SVG icons for actions (with aria-labels)");
  if (!has(/import\s*\(|new Worker\(|export\s*\{|export (?:const|function|class)/) && lines > 400) out.push("monolithic script — split into ES modules by subsystem (state, render, input, persistence, ui)");
  return out.slice(0, 16);
}


/** MODULE vs CLASSIC SCRIPT. The single most common way a generated multi-file app is dead on arrival:
 *  the files are written as ES modules (import/export) and index.html loads them with a plain
 *  <script src>. Every one of them then throws at parse time -
 *    "Uncaught SyntaxError: Cannot use import statement outside a module"
 *    "Uncaught SyntaxError: Unexpected token 'export'"
 *  - before a single line runs, so the page is blank and nothing downstream gets a chance to report why.
 *
 *  Nothing caught this. It is invisible to a per-file syntax check (each file is valid ON ITS OWN, as a
 *  module) and invisible to the reference lint (the files all exist). It is only visible by comparing how
 *  a file is WRITTEN against how it is LOADED, which is what this does.
 *
 *  Module syntax is detected on blanked source, so the word "export" inside a string or comment cannot
 *  raise a false alarm on a file that is genuinely a classic script. */
function lintModuleLoading(files: ArtFile[]): string[] {
  const out: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const isModule = (content: string) => {
    const code = blankNonCode(String(content ?? ""));
    return /^\s*import\s+[^(]/m.test(code) || /^\s*import\s*["']/m.test(code) || /^\s*export\s+(?:default|const|let|var|function|class|\{|\*)/m.test(code);
  };
  for (const f of files) {
    if (!/\.html?$/i.test(f.path)) continue;
    const html = f.content;
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      const attrs = m[1] ?? "";
      const srcM = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!srcM) continue;
      const ref = srcM[1].trim();
      if (/^(https?:|data:|blob:|\/\/)/i.test(ref)) continue;
      const target = safePath(ref.replace(/^\.\//, "").replace(/[?#].*$/, ""));
      const content = byPath.get(target);
      if (content === undefined) continue; // the missing-reference rule already covers this
      const declaredModule = /\btype\s*=\s*["']module["']/i.test(attrs);
      if (isModule(content) && !declaredModule) {
        out.push(`${f.path}: loads "${ref}" with <script src> but ${target} is an ES module (it uses import/export at top level) — the browser throws "Cannot use import statement outside a module" at parse time and the file never runs. Change the tag to <script type="module" src="${ref}"></script>, and note that module scripts are deferred, so any inline bootstrap that calls into it must also be type="module".`);
      }
    }
    // The inverse trap: an inline bootstrap using import/export inside a plain <script> block.
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1] ?? "", body = m[2] ?? "";
      if (/\bsrc\s*=/i.test(attrs)) continue;
      if (/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
      if (isModule(body)) out.push(`${f.path}: an inline <script> block uses import/export but is not type="module" — it throws at parse time. Add type="module" to that tag.`);
    }
  }
  return out;
}



/** Index of the paren matching the one at `from`, or null when unbalanced. Input must be blanked source. */
function balanced(code: string, from: number): { end: number } | null {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return { end: i }; }
  }
  return null;
}

/** Split on commas at nesting depth zero, so destructured parameters stay in one piece. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/** Browser/runtime globals a generated app may call without declaring. Conservative and broad on purpose:
 *  a false positive here sends the model chasing a symbol that was never wrong, which is worse than a miss. */
const BROWSER_GLOBALS = new Set(
  ("window document navigator location history screen localStorage sessionStorage indexedDB caches fetch console " +
   "JSON Math Date Object Array String Number Boolean Symbol BigInt Promise Set Map WeakMap WeakSet Proxy Reflect " +
   "RegExp Error TypeError RangeError SyntaxError EvalError ReferenceError URIError AggregateError " +
   "URL URLSearchParams FormData Blob File FileReader Image Audio Video Option Event CustomEvent EventTarget " +
   "MutationObserver ResizeObserver IntersectionObserver PerformanceObserver AbortController AbortSignal " +
   "setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask " +
   "requestIdleCallback cancelIdleCallback structuredClone reportError " +
   "TextEncoder TextDecoder btoa atob encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape " +
   "isNaN isFinite parseInt parseFloat NaN Infinity undefined globalThis self top parent frames " +
   "alert confirm prompt getComputedStyle matchMedia scrollTo scrollBy open close print focus blur postMessage " +
   "DOMParser XMLSerializer Node Element HTMLElement HTMLCanvasElement SVGElement DocumentFragment Range Selection " +
   "Uint8Array Uint16Array Uint32Array Int8Array Int16Array Int32Array Float32Array Float64Array BigInt64Array " +
   "ArrayBuffer SharedArrayBuffer DataView Atomics Intl WebSocket EventSource Worker SharedWorker MessageChannel " +
   "BroadcastChannel Notification crypto performance speechSynthesis SpeechSynthesisUtterance " +
   "AudioContext OfflineAudioContext webkitAudioContext GainNode OscillatorNode AnalyserNode " +
   "Path2D ImageData OffscreenCanvas createImageBitmap ResizeObserverEntry CSS customElements " +
   "HTMLImageElement HTMLAudioElement HTMLVideoElement HTMLInputElement FontFace " +
   "eval Function arguments this super import require module exports process " +
   "WebGLRenderingContext WebGL2RenderingContext GPUDevice navigator_gpu " +
   "define describe it test expect beforeEach afterEach").split(/\s+/).filter(Boolean),
);

/** UNRESOLVED CALLS ACROSS FILES.
 *
 *  The failure this catches, verbatim from a live run: "Uncaught TypeError: getState is not a function".
 *  Independently generated files agree on a name in one file and not the other - state.js never defines
 *  getState, or defines it without exporting it, or main.js calls it without importing it. Nothing saw
 *  this: each file parses, every referenced FILE exists, and the import/export check only validates the
 *  names that appear in an import statement. A symbol that is simply CALLED and never bound is invisible
 *  to all three.
 *
 *  Scope model follows how the browser actually loads the file. A module sees its own declarations plus
 *  what it imports. A classic script sees every other classic script's top-level declarations, because
 *  they all share the global object. Getting this wrong in either direction manufactures false positives,
 *  so the mode is derived per file rather than assumed.
 *
 *  Only CALL sites are flagged - `foo(` - never bare references. A bare identifier has too many innocent
 *  explanations; a call to something that was never defined has almost none. */
function lintUnresolvedCalls(files: ArtFile[]): string[] {
  const out: string[] = [];
  const js = files.filter((f) => /\.m?js$/i.test(f.path) && !f.content.startsWith("data:"));
  if (!js.length) return out;

  const html = files.filter((f) => /\.html?$/i.test(f.path));
  const moduleTagged = new Set<string>();
  for (const h of html) {
    for (const m of h.content.matchAll(/<script\b([^>]*)>/gi)) {
      const a = m[1] ?? "";
      const src = a.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (src && /\btype\s*=\s*["']module["']/i.test(a)) moduleTagged.add(safePath(src[1].replace(/^\.\//, "").replace(/[?#].*$/, "")));
    }
  }
  const declsOf = (code: string) => {
    const d = new Set<string>();
    for (const re of [
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
      /\bclass\s+([A-Za-z_$][\w$]*)/g,
      /\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/g,
      /\bimport\s*\{([^}]*)\}/g,
      /(?:const|let|var)\s*\{([^}]*)\}/g,
      /(?:const|let|var)\s*\[([^\]]*)\]/g,
      /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
      /(?:^|[,(])\s*([A-Za-z_$][\w$]*)\s*(?==>)/g,
    ]) {
      for (const m of code.matchAll(re)) {
        for (const piece of String(m[1] ?? "").split(",")) {
          const id = piece.trim().replace(/\s+as\s+/, " ").split(/\s+/).pop()!.replace(/[=:].*$/, "").replace(/^\.\.\./, "").trim();
          if (/^[A-Za-z_$][\w$]*$/.test(id)) d.add(id);
        }
      }
    }
    // Every parameter list, at any nesting depth. A regex cannot do this: a list like
    // `(cb, { onDone = () => {} } = {}, ...rest)` contains nested parens and braces, so a character-class
    // scan stops early and every parameter after the nesting is reported as an undefined global. Scan for
    // the BALANCED closing paren instead, then split the contents at depth zero.
    for (let i = 0; i < code.length; i++) {
      if (code[i] !== "(") continue;
      const inner = balanced(code, i);
      if (inner === null) continue;
      const after = code.slice(inner.end + 1).match(/^\s*(=>|\{)/);
      if (!after) continue;
      for (const piece of splitTop(code.slice(i + 1, inner.end))) {
        const id = piece.trim().replace(/[=:][\s\S]*$/, "").replace(/^\.\.\./, "").replace(/[{}\[\]]/g, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(id)) d.add(id);
      }
      // Also catch shorthand methods and function declarations: `name(params) {` DEFINES name.
      const before = code.slice(0, i).match(/([A-Za-z_$][\w$]*)\s*$/);
      if (before && after[1] === "{") d.add(before[1]);
    }
    return d;
  };

  const blanked = new Map(js.map((f) => [f.path, blankNonCode(f.content)]));
  const isModule = (f: ArtFile) => {
    const code = blanked.get(f.path)!;
    return moduleTagged.has(f.path) || /^\s*import\s+[^(]/m.test(code) || /^\s*export\s+/m.test(code);
  };
  // An artifact that loads a library from a CDN has globals no file here can declare (CodeMirror, THREE,
  // d3, Chart…). Reporting those as undefined would bury the real finding in noise, so when any remote
  // script is present the "nothing defines it" branch is suppressed. The cross-file branch survives: if a
  // symbol IS defined in a sibling file, no CDN can explain away the missing import.
  // Libraries arrive two ways and BOTH have to count: a static <script src="https://…"> in the HTML, and
  // a loader inside the JS that builds a script element at runtime (which is how CodeMirror gets in, and
  // why checking only the HTML still reported CodeMirror as undefined). Any remote URL anywhere in the
  // artifact means some global here may be supplied from outside it.
  const hasExternalScripts = [...html, ...js].some((h) => /https?:\/\//i.test(h.content));
  const classicPool = new Set<string>();
  for (const f of js) if (!isModule(f)) for (const id of declsOf(blanked.get(f.path)!)) classicPool.add(id);

  for (const f of js) {
    const code = blanked.get(f.path)!;
    const own = declsOf(code);
    const visible = isModule(f) ? own : new Set([...own, ...classicPool]);
    const reported = new Set<string>();
    for (const m of code.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const id = m[2];
      if (reported.has(id) || visible.has(id) || BROWSER_GLOBALS.has(id)) continue;
      // `run() {` in an object literal, a class body, or a function declaration is a DEFINITION that
      // happens to look exactly like a call. A real call is never followed by a block.
      const open = code.indexOf("(", (m.index ?? 0) + m[1].length + id.length - 1);
      const bal = open >= 0 ? balanced(code, open) : null;
      if (bal && /^\s*\{/.test(code.slice(bal.end + 1))) continue;
      // `async (x) => …` puts `async` immediately before a paren and it is a keyword, not a callee.
      if (/^(if|for|while|switch|catch|return|typeof|instanceof|void|delete|new|do|else|in|of|yield|await|async|case|function|class|throw|static|get|set|constructor|super|import|export|default|from|as|let|const|var)$/.test(id)) continue;
      reported.add(id);
      const line = code.slice(0, m.index ?? 0).split("\n").length;
      const definedElsewhere = js.find((o) => o.path !== f.path && declsOf(blanked.get(o.path)!).has(id));
      if (!definedElsewhere && hasExternalScripts) continue; // could legitimately come from the CDN library
      out.push(definedElsewhere
        ? `${f.path}:${line}: calls ${id}() but never imports it — it is defined in ${definedElsewhere.path}. As written this throws "${id} is not a function" at runtime. Add: import { ${id} } from "./${definedElsewhere.path}"; and make sure ${definedElsewhere.path} exports it.`
        : `${f.path}:${line}: calls ${id}() but nothing in this artifact defines it — this throws "${id} is not a function" (or "is not defined") the moment that line runs. Define it, import it, or remove the call.`);
      if (out.length >= 12) return out;
    }
  }
  return out;
}


/** BROWSERS DO NOT RUN TYPESCRIPT OR JSX.
 *
 *  There is no build step here: an artifact has to run from /artifact/<id>/, from a static host, and from
 *  file:// with nothing installed. A .ts/.tsx/.jsx file satisfies none of those - the browser fetches it,
 *  hits the first type annotation or JSX tag, and throws a SyntaxError at parse time. Val Town transpiles
 *  ITS OWN val files on the way out; artifact files are rows in this database and get no such treatment.
 *
 *  So these files are viewable and editable (see MIME above) but cannot be entry points. The fix is to
 *  ship plain .js, which is also the only form that survives being copied to a static host. */
function lintUncompiledSources(files: ArtFile[]): string[] {
  const out: string[] = [];
  const typed = files.filter((f) => /\.(tsx?|jsx|mts|cts)$/i.test(f.path) && !f.content.startsWith("data:"));
  if (!typed.length) return out;

  for (const h of files.filter((f) => /\.html?$/i.test(f.path))) {
    for (const m of h.content.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      const ref = safePath(m[1].replace(/^\.\//, "").replace(/[?#].*$/, ""));
      if (!/\.(tsx?|jsx|mts|cts)$/i.test(ref)) continue;
      if (!files.some((f) => f.path === ref)) continue;
      out.push(`${h.path}: loads "${m[1]}" but no browser can execute TypeScript or JSX — it throws a SyntaxError at parse time on the first type annotation or JSX tag, and there is no build step in this sandbox, on a static host, or under file://. Compile it to plain JavaScript and ship ${ref.replace(/\.(tsx?|jsx|mts|cts)$/i, ".js")} instead.`);
    }
  }
  for (const f of typed) {
    for (const m of f.content.matchAll(/^\s*(?:import|export)[^;\n]*?["'](\.{1,2}\/[^"']+\.(?:tsx?|jsx|mts|cts))["']/gm)) {
      out.push(`${f.path}: imports "${m[1]}" — a browser cannot resolve or execute a TypeScript/JSX module at runtime. Both files must be compiled to .js, with the import rewritten to the .js path.`);
      break;
    }
  }
  if (!out.length) {
    out.push(`${typed.map((f) => f.path).join(", ")}: TypeScript/JSX source is present but nothing loads it. These files cannot run in a browser as-is — keep them only as reference, or compile them to .js and load that.`);
  }
  return out.slice(0, 6);
}

/** Portability: the artifact must run from a static host, from this sandbox (/artifact/<id>/, strict CSP) AND opened from
 *  disk (file://). Each finding names a construct that works in at most one of those three. Line-based, first hit per file per rule. */
const PORTABILITY_RX: [RegExp, string, RegExp | null][] = [
  [/\/artifact\/\d*/, "hard-coded sandbox path /artifact/… — use a relative path (./file)", null],
  [/(?:src|href)\s*=\s*["']\/(?!\/)/i, "root-absolute URL (\"/…\") — breaks on any host that is not the site root and on file://; use ./…", /\.html?$/],
  [/<base\b/i, "<base> tag pins the document URL to one host — remove it", /\.html?$/],
  [/\b(?:window\.)?(?:parent|top)\.(?:postMessage|location|document)\b/, "assumes a host frame (parent/top) — the app runs standalone outside the sandbox; feature-detect or remove", null],
  [/\blocation\.(?:origin|pathname|host)\b\s*\+/, "builds URLs from location.origin/pathname — differs per host and is empty on file://; use relative URLs", null],
  [/\bfetch\(\s*["'`](?!https?:|\/\/|data:|blob:)[^"'`]*\.(?:json|glsl|wgsl|txt|csv|frag|vert)["'`]/, "fetch() of a local file fails when index.html is opened from disk (file:// CORS) — ship it as a .js module (export const …)", null],
  [/\b(?:XMLHttpRequest|importScripts)\s*\(/, "XHR/importScripts of local files fails on file:// — bundle into .js modules", null],
  [/\bnavigator\.serviceWorker\.register\(/, "service workers do not register on file:// or in the sandbox — guard with `if ('serviceWorker' in navigator && location.protocol.startsWith('http'))`", null],
  [/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem)\(/, "storage access must be inside try/catch with an in-memory fallback (throws in some file:// / private contexts)", null],
];
export function lintPortability(files: ArtFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.content.startsWith("data:") || /\.(json|md|txt|csv|svg|css)$/i.test(f.path)) continue;
    const lines = blankCommentsAndRegex(f.content).split("\n");
    const raw = f.content.split("\n");
    const hit = new Set<number>();
    const guarded = /try\s*\{/.test(f.content); /* any try block in the file: a storage wrapper counts, the model is told the exact rule otherwise */
    for (let i = 0; i < lines.length && out.length < 12; i++) {
      const line = lines[i];
      PORTABILITY_RX.forEach(([rx, why, only], k) => {
        if (hit.has(k) || (only && !only.test(f.path)) || !rx.test(line)) return;
        if (k === 8 && guarded) return;
        if (k === 3 && /\bin\s+window|typeof\s+parent|window\.parent\s*!==?\s*window|self\s*!==?\s*top/.test(f.content)) return;
        hit.add(k); out.push(`${f.path}:${i + 1}: portability — ${why} — "${line.trim().slice(0, 80)}"`);
      });
    }
  }
  return out;
}

/** Placeholder / stub detector. The user's standing rule: no dummy code, ever. Anything matched here is returned to the
 *  model as an issue it must resolve before the turn can end. Line-based, comment- and string-aware enough for the
 *  patterns models actually emit. */
/** scope: "comment" reads the raw line (evidence lives in the comment), "code" reads the line with
 *  comments and regex literals blanked (evidence lives in code or in a string literal), "both" reads
 *  each. Getting this wrong in either direction is a page of false positives or a missed stub. */
const PLACEHOLDER_RX: [RegExp, string, "comment" | "code" | "both" | "raw"][] = [
  [/\b(TODO|FIXME|XXX|HACK)\b/, "TODO marker", "comment"],
  // `bind: unbound placeholder :name` (SQL) and `<input placeholder="…">` are not unfinished work, and
  // a summariser that legitimately emits "[omitted]" is not either. The word has to be ABOUT the code.
  [/(?<![.:\w-])(?:placeholder\s+(?:code|implementation|content|text|value|here)|stub(?:bed)?\b|dummy\b|mock(?:ed)?\s+(?:data|impl|implementation|function)|not\s+implemented|to\s+be\s+implemented|implement\s+(?:this|later|me)|left\s+as\s+an\s+exercise|for\s+brevity|simplified\s+version|in\s+a\s+real\s+(?:app|implementation|project))\b/i, "placeholder wording", "code"],
  [/throw\s+new\s+Error\(\s*["'](?:not implemented|todo|unimplemented)/i, "unimplemented throw", "code"],
  [/^\s*(?:\/\/|#)\s*\.\.\.\s*$|\/\*\s*\.\.\.\s*\*\/|^\s*\.\.\.\s*$/, "elided code (…)", "comment"],
  [/(?:\/\/|\/\*|#)[\s.…]*(?:rest of|remaining|more|other)\s+(?:the\s+)?(?:code|logic|implementation|cases|methods|handlers|functions|files)\b/i, "elided section", "comment"],
  [/(?:\/\/|\/\*|#)\s*(?:add|insert|put|your)\s+(?:your\s+)?(?:code|logic|implementation|api key|key)\s+here/i, "fill-in comment", "comment"],
  [/\blorem\s+ipsum\b/i, "lorem ipsum", "code"],
  // `= () => {}` in a parameter list is the standard "optional callback" default, not an unfinished
  // function; flagging it told three correct call sites to "replace with the real implementation".
  // A DECLARED function with an empty body still is a finding, and so is `x = () => {}` as a statement.
  [/\bfunction\s+(?!noop\b|nop\b)\w+\s*\([^)]*\)\s*\{\s*\}|^\s*(?:const|let|var)\s+\w+\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*\{\s*\}\s*;?\s*$/, "empty function body", "code"],
  [/\breturn\s+(?:null|undefined|\[\]|\{\}|0|""|'')\s*;?\s*\/\/\s*(?:todo|placeholder|stub|temp|for now)/i, "stub return", "raw"],
  [/console\.log\(\s*["'](?:todo|not implemented|stub)/i, "stub log", "code"],
  [/\bsetTimeout\(\s*\(\)\s*=>\s*\{\s*\}/, "empty timer", "code"],
];
/** A line that CONTAINS a regex literal is, overwhelmingly, a line that describes patterns rather than
 *  one that is an unfinished implementation - a rule table, a tokenizer, a validator. Its quoted labels
 *  ("TODO marker", "lorem ipsum") name what the pattern detects. Flagging those told the model to
 *  "replace with the real implementation" on a table that WAS the real implementation. Only the three
 *  vocabulary rules are suppressed; a genuinely empty function body on such a line still reports. */
const REGEX_LITERAL_RX = /(?:^|[=,([:!&|?{};+\-*%~^]|\breturn\b)\s*\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\\/\n])+\/[gimsuyd]*/;
/** Text that FORBIDS placeholders is not a placeholder. Prompt strings, rule descriptions and specs say
 *  "no stubs, no dummy data"; matching the vocabulary inside a prohibition is the same class of error. */
const PROHIBITION_RX = /\b(?:no|never|without|avoid|avoids|forbid|forbids|forbidden|prohibit(?:ed|s)?|disallow(?:ed|s)?|must\s+not|may\s+not|do\s+not|don'?t|not\s+allowed|zero)\b/i;
// Deliberately NOT "TODO marker". That rule reads the COMMENT line, and comments routinely contain both
// prohibitions ("TODO: don't forget to flush") and slashes that scan as regex literals ("TODO: handle
// /foo/ paths"); suppressing it there would lose real markers. Both suppressed kinds read the code line.
const VOCAB_KINDS = new Set(["placeholder wording", "lorem ipsum"]);
export function lintPlaceholders(files: ArtFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.content.startsWith("data:") || /\.(json|md|txt|csv|svg)$/i.test(f.path)) continue;
    const rawLines = f.content.split("\n");
    const codeLines = blankCommentsAndRegex(f.content).split("\n");
    const cmtLines = commentsOnly(f.content).split("\n");
    for (let i = 0; i < rawLines.length && out.length < 12; i++) {
      if (/^\s*$/.test(rawLines[i])) continue;
      const describesPatterns = REGEX_LITERAL_RX.test(rawLines[i]) || PROHIBITION_RX.test(rawLines[i]);
      for (const [rx, kind, scope] of PLACEHOLDER_RX) {
        if (describesPatterns && VOCAB_KINDS.has(kind)) continue;
        const line = scope === "comment" ? cmtLines[i] : scope === "raw" ? rawLines[i] : codeLines[i];
        // Report the ORIGINAL line, so the message shows what is actually in the file.
        const alt = scope === "both" ? rawLines[i] : null;
        if (rx.test(line) || (alt !== null && rx.test(alt))) { out.push(`${f.path}:${i + 1}: ${kind} — "${(rawLines[i] ?? line).trim().slice(0, 90)}" — replace with the real implementation`); break; }
      }
    }
  }
  return out;
}

/** Every relative path an HTML file points at with src=/href= that the artifact does not contain.
 *
 *  This is the "failed to load link style.css (404 or blocked)" report, answered structurally instead of
 *  by reading a console. lintArtifact already NOTICES these - it files an issue against the referrer -
 *  but the file to fix is the ABSENT one, not the page that correctly asks for it. A repair that edits
 *  index.html to stop referencing style.css has deleted a feature; the repair that is wanted writes
 *  style.css. So this returns the missing targets themselves, each with who asked for it. */
export function missingRefs(files: ArtFile[]): { path: string; referrers: string[] }[] {
  const have = new Set(files.map((f) => f.path));
  const want = new Map<string, Set<string>>();
  for (const f of files) {
    if (!/\.html?$/.test(f.path) || f.content.startsWith("data:")) continue;
    for (const m of f.content.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi)) {
      const ref = m[1].trim();
      if (/^(https?:)?\/\//i.test(ref) || /^(data:|blob:|mailto:|javascript:|#)/i.test(ref)) continue;
      const rel = safePath(ref.replace(/^\.\//, ""));
      if (!rel || have.has(rel)) continue;
      if (!want.has(rel)) want.set(rel, new Set());
      want.get(rel)!.add(f.path);
    }
  }
  return [...want.entries()].map(([path, refs]) => ({ path, referrers: [...refs] }));
}

/** Cross-file ES-module contract check: every `import { X } from "./y.js"` must name something y.js actually exports.
 *  This is the failure mode of independently written files ("does not provide an export named …") and it is a
 *  load-time error in the browser, so it must be caught before the preview runs. */
export function lintModuleGraph(files: ArtFile[]): string[] {
  const out: string[] = [];
  const exportsOf = new Map<string, Set<string>>();
  const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
  const resolve = (from: string, spec: string) => { const parts = (dir(from) + spec.replace(/^\.\//, "")).split("/"); const o: string[] = []; for (const x of parts) { if (x === "..") o.pop(); else if (x !== ".") o.push(x); } return o.join("/"); };
  for (const f of files) {
    if (!/\.m?js$/.test(f.path) || f.content.startsWith("data:")) continue;
    const names = new Set<string>();
    for (const m of f.content.matchAll(/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    for (const m of f.content.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(",")) { const nm = part.trim().split(/\s+as\s+/); const exported = (nm[1] ?? nm[0]).trim(); if (exported) names.add(exported); }
    if (/^\s*export\s+default\b/m.test(f.content)) names.add("default");
    for (const m of f.content.matchAll(/^\s*export\s*\*\s*from\s*["']([^"']+)["']/gm)) names.add("*from:" + resolve(f.path, m[1]));
    exportsOf.set(f.path, names);
  }
  const has = (path: string, name: string, seen = new Set<string>()): boolean => {
    const ex = exportsOf.get(path); if (!ex || seen.has(path)) return false; seen.add(path);
    if (ex.has(name)) return true;
    for (const k of ex) if (k.startsWith("*from:") && has(k.slice(6), name, seen)) return true;
    return false;
  };
  for (const f of files) {
    if (!/\.m?js$/.test(f.path) || f.content.startsWith("data:")) continue;
    for (const m of f.content.matchAll(/^\s*import\s+([^;]*?)\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm)) {
      const target = resolve(f.path, m[2]);
      if (!exportsOf.has(target)) { if (!files.some((x) => x.path === target)) out.push(`${f.path}: imports "${m[2]}" but ${target} does not exist`); continue; }
      const clause = m[1].trim();
      const wanted: string[] = [];
      const braces = clause.match(/\{([^}]*)\}/);
      if (braces) for (const part of braces[1].split(",")) { const nm = part.trim().split(/\s+as\s+/)[0].trim(); if (nm) wanted.push(nm); }
      const rest = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+\w+/, "").replace(/,/g, " ").trim();
      if (rest) wanted.push("default");
      const missing = wanted.filter((n) => !has(target, n));
      if (missing.length) out.push(`${f.path}: imports { ${missing.join(", ")} } from "${m[2]}" but ${target} exports only [${[...(exportsOf.get(target) ?? [])].filter((k) => !k.startsWith("*from:")).join(", ") || "nothing"}] — add the export or fix the name`);
    }
  }
  return out;
}

/** Content/extension mismatch detector. Direct response to a reported failure mode: the model writes JS (or a whole
 *  HTML document) to the wrong file — e.g. `update_artifact` called with JS source and an .html path, or vice versa.
 *  Whole-file heuristics only (not line-based like the others above), since the signal is the file's overall shape,
 *  not one bad line. False-positive guard: a .js/.ts file that merely CONTAINS an HTML string (a template literal,
 *  an innerHTML assignment) is fine — this only fires when the file STARTS with a full HTML document, which no
 *  legitimate JS/CSS file ever does. */
export function lintFileKind(files: ArtFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.content.startsWith("data:")) continue; // binary
    const trimmed = f.content.trimStart();
    const looksLikeHtmlDoc = /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);

    if (/\.(?:m?js|ts|tsx|jsx)$/i.test(f.path)) {
      if (looksLikeHtmlDoc) {
        out.push(`${f.path}: this is a JS/TS file but its content is a full HTML document (starts with ${trimmed.slice(0, 40).replace(/\n/g, " ")}...) — it was written to the wrong file; move this content to the HTML entry file and write real JS/TS here, or re-issue the write with the correct path`);
      }
      continue;
    }

    if (/\.css$/i.test(f.path)) {
      if (looksLikeHtmlDoc || /<script\b/i.test(trimmed.slice(0, 200)) || /^<html\b/i.test(trimmed)) {
        out.push(`${f.path}: this is a CSS file but its content looks like HTML/JS markup — it was written to the wrong file; write plain CSS rules here`);
      }
      continue;
    }

    if (/\.html?$/i.test(f.path)) {
      if (!looksLikeHtmlDoc && !trimmed.includes("<")) {
        // No angle brackets at all in an .html file is only suspicious once it also looks like code, not e.g. a
        // one-line placeholder file — require a JS-shaped opening to flag it, so an empty or near-empty file is left alone.
        const jsShaped = /^(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|\(function|\(\s*\)\s*=>)/.test(trimmed);
        if (jsShaped) out.push(`${f.path}: this is the HTML file but its content looks like JavaScript (starts with "${trimmed.slice(0, 40).replace(/\n/g, " ")}...") with no HTML markup at all — it was written to the wrong file; this file needs a real <!doctype html> document, and the JS content belongs in a .js file instead`);
      }
      continue;
    }
  }
  return out;
}

/** Response for /artifact/<id>/<path>. CSP allows same-origin siblings + inline; nothing else. */
/** Console/error hook injected at SERVE time into artifact HTML (never stored): forwards console output, script errors,
 *  unhandled rejections and failed resource loads (404 script/link/img) to the workbench via postMessage, so the preview's
 *  errors are visible and auto-fixable whether the page is served from /artifact/<id>/ or rendered live. Standalone it is inert. */
/*  Written out longhand rather than kept as one minified line. The behaviour is byte-for-byte the same;
 *  the reason for the change is that a 900-character single-line IIFE sitting in the source as a string
 *  literal is indistinguishable, to anything reading shape instead of meaning, from an injected payload
 *  -- and it was unmaintainable besides.
 *
 *  targetOrigin stays "*" DELIBERATELY. The workbench frames this page from srcdoc as well as from
 *  /artifact/<id>/, and a srcdoc frame's origin is opaque in some browsers. Naming an explicit origin
 *  there does not throw -- it silently drops the message, which would switch preview error capture off
 *  in a way nobody would ever notice. The payload is the user's own app's console output, which the
 *  framing page can already read. A quieter scanner score is not worth a silent regression. */
const HOOK_SOURCE = String.raw`
(function () {
  // WHERE a log came from. console.log/warn/error carry no location of their own, so the only way to
  // recover one is to throw an Error at the call site and read its stack. The first frames belong to this
  // hook (send, and the console[level] wrapper that called it); the first frame after those is the real
  // caller. Without this, the app's console panel showed a message with no file and no line, which is
  // exactly as useless as "Script error."
  function originOf(skipWrapper) {
    try {
      var lines = String(new Error().stack || "").split("\n");
      var frames = [];
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        if (!/:\d+:\d+/.test(L)) continue;                        // not a frame
        if (/\b(originOf|send|report)\b/.test(L)) continue;        // named frames belonging to this hook
        frames.push(L);
      }
      // The console override that called send() is also our frame, but it is ANONYMOUS in some engines
      // (V8 prints "console.<computed> [as warn]", Firefox prints nothing), so it cannot be matched by
      // name. It is always exactly one frame though, so it is dropped by POSITION. report() is invoked
      // from an event handler with no such wrapper, hence the flag.
      if (skipWrapper) frames.shift();
      for (var j = 0; j < frames.length; j++) {
        var m = frames[j].match(/([^\s()@]+):(\d+):(\d+)\)?\s*$/);
        if (!m) continue;
        var file = m[1].replace(/[?#].*$/, "").replace(/^.*?\/artifact\/\d+\//, "").split("/").pop();
        if (!file) continue;
        return { file: file, line: Number(m[2]), col: Number(m[3]), frame: frames[j].trim() };
      }
    } catch (e) { /* stacks are best-effort */ }
    return null;
  }

  function send(level, args) {
    try {
      var text = Array.prototype.slice.call(args).map(function (x) {
        try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); }
      }).join(" ");
      var o = originOf(true);
      parent.postMessage({
        omniConsole: 1, level: level,
        text: o ? text + "  (" + o.file + ":" + o.line + ")" : text,
        origin: o, raw: text
      }, "*");
    } catch (e) { /* no parent, or a frame that refuses messages: the page must not break over telemetry */ }
  }

  ["log", "info", "warn", "error"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      send(level, arguments);
      if (original) original.apply(console, arguments);
    };
  });

  // Capture phase, because resource load failures (404 script/link/img) fire on the element and do not bubble.
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) {
      var file = String(t.src || t.href).split("/").pop();
      send("error", ["failed to load " + String(t.tagName || "resource").toLowerCase() + " " + file + " (404 or blocked)"]);
      return;
    }
    send("error", [e.message + " (" + String(e.filename || "").split("/").pop() + ":" + e.lineno + ")"]);
  }, true);

  window.addEventListener("unhandledrejection", function (e) {
    send("error", ["unhandled: " + ((e.reason && e.reason.message) || e.reason)]);
    report("unhandledrejection", e.reason);
  });

  // STRUCTURED report, sent alongside the human-readable console line. The console line is for a person
  // reading the preview; this is what the repair pipeline resolves against the artifact's own source.
  // Values of locals are deliberately absent - JavaScript cannot read them off a stack frame. What CAN be
  // observed is captured instead: the error's own properties, its cause chain, and any snapshot the page
  // chose to publish on window.__omniState.
  function report(kind, err) {
    try {
      var props = {};
      if (err && typeof err === "object") {
        Object.keys(err).forEach(function (k) {
          if (k === "stack" || k === "message") return;
          try { var v = err[k]; props[k] = (typeof v === "object" && v !== null) ? "[object]" : v; } catch (e2) {}
        });
        ["name", "code", "status"].forEach(function (k) { if (err[k] !== undefined && props[k] === undefined) props[k] = err[k]; });
      }
      var causes = [], cur = err, guard = 0;
      while (cur && typeof cur === "object" && cur.cause && guard++ < 5) { cur = cur.cause; causes.push(String((cur && cur.message) || cur)); }
      var state = null;
      try { var st = window.__omniState; state = typeof st === "function" ? st() : st; if (state && typeof state !== "object") state = { value: String(state) }; } catch (e3) { state = { __stateError: String(e3 && e3.message) }; }
      parent.postMessage({
        omniError: 1, kind: kind,
        message: String((err && err.message) || err || "(no message)").slice(0, 1000),
        stack: String((err && err.stack) || "").slice(0, 8000),
        props: props, causes: causes, state: state, href: String(location.href)
      }, "*");
    } catch (e4) { /* diagnostics must never become the failure */ }
  }

  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) {
      report("resource", { message: "failed to load " + String(t.tagName || "resource").toLowerCase() + " " + String(t.src || t.href).split("/").pop() + " (404 or blocked)" });
      return;
    }
    // MASKED CROSS-ORIGIN ERROR. When a script comes from an opaque origin - which is every module the
    // live preview rewrites to a data: URL - the browser refuses to disclose the real message, file or
    // line, and hands window.onerror the fixed string "Script error." with lineno 0. Forwarding that
    // verbatim is worse than dropping it: six identical useless lines filled the error budget sent to the
    // model, crowding out anything it could have acted on. Say what it actually means instead.
    if (!e.error && /^Script error\.?$/i.test(String(e.message || "")) && !e.filename) {
      report("masked", { message: "A script failed, but the browser withheld the details because it was loaded from an opaque origin (the live preview serves modules as data: URLs). The real error is visible in the browser console, and in the saved preview at /artifact/<id>/ where the same script is same-origin. Most often this is a parse-time failure - an ES module loaded with a plain <script src> tag, which the module-loading lint reports precisely.", name: "MaskedCrossOriginError" });
      return;
    }
    report("error", e.error || { message: e.message, stack: e.filename ? "    at " + e.filename + ":" + e.lineno + ":" + (e.colno || 0) : "" });
  }, true);
})();
`;
export const CONSOLE_HOOK = `<script>${HOOK_SOURCE}</script>`;
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Base64 -> bytes with an explicit bit accumulator, in place of Uint8Array.from(atob(s), c => c.charCodeAt(0)).
 *  Differential-tested against atob over random inputs at every length 0..64: identical output. Same cost, and it
 *  drops an idiom that is far more often seen unpacking a payload than decoding a PNG. */
function base64Bytes(s: string) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_ALPHABET.indexOf(clean[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.slice(0, o); // slice, not subarray: an exact-length Uint8Array is a valid BodyInit, a view over a larger buffer is not
}

export function serveFile(origin: string, path: string, content: string): Response {
  let ct = mimeFor(path || "index.html");
  let body: BodyInit = content;
  if (/^(index\.html?)?$/.test(path) || /\.html?$/.test(path)) { const i = content.search(/<head[^>]*>/i); body = i >= 0 ? content.slice(0, content.indexOf(">", i) + 1) + CONSOLE_HOOK + content.slice(content.indexOf(">", i) + 1) : CONSOLE_HOOK + content; }
  const m = content.length < 12_000_000 && content.startsWith("data:") ? content.match(/^data:([^;,]+)?(;base64)?,/) : null;
  if (m) { // binary asset stored as a data URL by the workbench/zip import
    ct = m[1] || ct; const raw = content.slice(m[0].length);
    body = m[2] ? base64Bytes(raw) : decodeURIComponent(raw);
  }
  return new Response(body, {
    headers: {
      "content-type": ct,
      "content-security-policy": `default-src 'none'; script-src ${origin} 'unsafe-inline' 'unsafe-eval'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob: https:; font-src ${origin} data:; connect-src ${origin} data: blob:; media-src ${origin} data: blob:; worker-src ${origin} blob:; frame-ancestors 'self'`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** Pull a full HTML document out of a reply when the model wrote code instead of calling create_artifact. */
export function extractHtmlDocument(reply: string): { title: string; html: string } | null {
  const m = reply.match(/```(?:html|htm)?\s*\n([\s\S]*?)\n```/gi);
  if (!m) return null;
  for (const block of m) {
    const html = block.replace(/^```\w*\s*\n/, "").replace(/\n```$/, "");
    if (/<html[\s>]|<!doctype html/i.test(html) && html.split("\n").length >= 25) {
      const t = html.match(/<title>([^<]{1,80})<\/title>/i);
      return { title: t ? t[1].trim() : "App", html };
    }
  }
  return null;
}
