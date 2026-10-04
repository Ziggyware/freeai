// Runtime-error enrichment: turn a browser error into something a model can actually repair.
//
// WHAT A MODEL WAS GETTING BEFORE: a single flat string, e.g.
//   "Cannot read properties of null (reading 'width') (render.js:84)"
// That names a symptom and a location and nothing else. The model has to guess at the code, so it guesses
// at the fix, and a guessed fix is how a repair round turns into six repair rounds.
//
// WHAT IT GETS NOW: every frame of the stack resolved against the artifact's OWN stored source - the
// offending line with a caret under the column, a window of context around it, the enclosing function and
// its parameters, and the identifiers declared in each enclosing scope, walked outward frame by frame.
//
// ON VARIABLE VALUES, PLAINLY: JavaScript exposes no way to read a stack frame's locals. There is no
// reflection API for frame state in V8 or in any browser; only the debugger protocol can do it, and that
// requires DevTools attached to the page. Anything that claimed to report locals' VALUES from inside an
// error handler would be inventing them. So this reports what is real: names, declaration sites, scope
// nesting, and the values that genuinely are observable - the error's own properties, its `cause` chain,
// and whatever the page published to the state registry before it threw.
import type { ArtFile } from "./artifacts.ts";

export type Frame = {
  fn: string; // function name as the engine reported it, or "(anonymous)"
  file: string; // normalized to an artifact-relative path where one matches
  line: number;
  col: number;
  raw: string;
};

export type ScopeInfo = {
  /** Enclosing function signature as written in the source, outermost last. */
  chain: { kind: string; name: string; params: string[]; line: number; declares: string[] }[];
};

export type EnrichedFrame = Frame & {
  /** Source window: [lineNumber, text][] with the error line included. */
  window: [number, string][];
  caret: string | null; // marker row aligned to `col`, when a column was reported
  scope: ScopeInfo | null;
  resolved: boolean; // did we find this file among the artifact's own files?
};

export type ErrorReport = {
  message: string;
  kind: string; // "error" | "unhandledrejection" | "resource" | "console"
  frames: EnrichedFrame[];
  props: Record<string, unknown>; // own enumerable properties of the thrown value
  causes: string[]; // e.cause chain, outermost first
  state: Record<string, unknown> | null; // whatever the page published (see STATE_REGISTRY_NOTE)
  at: number;
};

export const STATE_REGISTRY_NOTE =
  "A page may publish diagnostic state by assigning an object to window.__omniState (or calling window.__omniState = () => ({...}) for a lazily computed snapshot). Whatever it holds at throw time is captured here. This is the only honest substitute for reading locals off the stack, which JavaScript does not permit.";

/* ────────────────────────────── stack parsing ──────────────────────────────
   Two shapes cover every engine we care about:
     V8/Chrome   "    at fnName (https://host/artifact/12/render.js:84:19)"
     Firefox/Safari  "fnName@https://host/artifact/12/render.js:84:19"
   Anything unparseable is kept verbatim rather than dropped: an unknown frame
   still tells the model where in the chain the gap is.                        */

const V8 = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const SPIDERMONKEY = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string, knownFiles: string[] = []): Frame[] {
  const out: Frame[] = [];
  for (const raw of String(stack ?? "").split("\n")) {
    const t = raw.trim();
    if (!t || /^[A-Za-z]*Error\b/.test(t) && !/\bat\b|@/.test(t)) continue; // the message line
    const m = t.match(V8) ?? t.match(SPIDERMONKEY);
    if (!m) { if (/\bat\b|@/.test(t)) out.push({ fn: "(unparsed)", file: "", line: 0, col: 0, raw: t }); continue; }
    const [, fnRaw, fileRaw, lineS, colS] = m;
    out.push({
      fn: (fnRaw || "").trim() || "(anonymous)",
      file: normalizeFile(fileRaw, knownFiles),
      line: Number(lineS) || 0,
      col: Number(colS) || 0,
      raw: t,
    });
  }
  return out;
}

/** Map a URL from a stack frame back to an artifact-relative path. Falls back to the basename so a frame
 *  from a file we do not have still reads sensibly instead of as a full URL with a cache-busting query. */
export function normalizeFile(url: string, knownFiles: string[] = []): string {
  let u = String(url ?? "").trim().replace(/[?#].*$/, "");
  u = u.replace(/^.*?\/artifact\/\d+\//, ""); // our own serving path
  const exact = knownFiles.find((f) => f === u);
  if (exact) return exact;
  const base = u.split("/").pop() ?? u;
  const byBase = knownFiles.find((f) => f === base || f.endsWith("/" + base));
  return byBase ?? (u.startsWith("http") ? u : base);
}

/* ────────────────────── source blanking (correctness first) ──────────────────
   Brace counting over raw source is wrong: a brace inside a string or comment
   moves the depth and every scope decision after it is garbage. This replaces
   the CONTENTS of strings, template literals, regex literals and comments with
   spaces while preserving length and newlines, so every offset still lines up
   with the original text.                                                      */

export function blankNonCode(src: string): string {
  const s = String(src ?? "");
  const out = s.split("");
  let i = 0;
  const n = s.length;
  const isRegexPos = (k: number) => {
    for (let j = k - 1; j >= 0; j--) {
      const c = s[j];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      return !/[A-Za-z0-9_$)\]]/.test(c); // after a value ⇒ division, not a regex
    }
    return true;
  };
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") { while (i < n && s[i] !== "\n") { out[i] = " "; i++; } continue; }
    if (c === "/" && d === "*") { out[i] = out[i + 1] = " "; i += 2; while (i < n && !(s[i] === "*" && s[i + 1] === "/")) { if (s[i] !== "\n") out[i] = " "; i++; } if (i < n) { out[i] = out[i + 1] = " "; i += 2; } continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < n) {
        if (s[i] === "\\") { out[i] = " "; if (s[i + 1] !== "\n") out[i + 1] = " "; i += 2; continue; }
        if (s[i] === q) { i++; break; }
        if (s[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && isRegexPos(i)) {
      let j = i + 1, ok = false, cls = false;
      while (j < n && s[j] !== "\n") {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === "[") cls = true;
        else if (s[j] === "]") cls = false;
        else if (s[j] === "/" && !cls) { ok = true; break; }
        j++;
      }
      if (ok) { for (let k = i + 1; k < j; k++) out[k] = " "; i = j + 1; continue; }
    }
    i++;
  }
  return out.join("");
}


/** Blank COMMENTS and REGEX LITERALS, keep string contents. Length and newlines are preserved.
 *
 *  blankNonCode() also blanks strings, which is right for brace counting and wrong for the placeholder
 *  lint: a genuine stub is usually `throw new Error("not implemented")`, and the evidence lives inside
 *  the string. But scanning RAW source is wrong in the other direction - it flags every comment that
 *  discusses placeholders, and every rule definition that lists the words it searches for. Both happened:
 *  a lint run over this codebase reported its own detector regex and a dozen explanatory comments.
 *
 *  Blanking comments and regex literals while keeping strings is the combination that reads code. */
export function blankCommentsAndRegex(src: string): string {
  const s = String(src ?? "");
  const out = s.split("");
  let i = 0;
  const n = s.length;
  const isRegexPos = (k: number) => {
    for (let j = k - 1; j >= 0; j--) {
      const c = s[j];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      return !/[A-Za-z0-9_$)\]]/.test(c);
    }
    return true;
  };
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") { while (i < n && s[i] !== "\n") { out[i] = " "; i++; } continue; }
    if (c === "/" && d === "*") { out[i] = out[i + 1] = " "; i += 2; while (i < n && !(s[i] === "*" && s[i + 1] === "/")) { if (s[i] !== "\n") out[i] = " "; i++; } if (i < n) { out[i] = out[i + 1] = " "; i += 2; } continue; }
    if (c === '"' || c === "'" || c === "`") { // strings are KEPT verbatim, only skipped over
      const q = c; i++;
      while (i < n) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && isRegexPos(i)) {
      let j = i + 1, ok = false, cls = false;
      while (j < n && s[j] !== "\n") {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === "[") cls = true;
        else if (s[j] === "]") cls = false;
        else if (s[j] === "/" && !cls) { ok = true; break; }
        j++;
      }
      if (ok) { for (let k = i; k <= j; k++) out[k] = " "; i = j + 1; continue; }
    }
    i++;
  }
  return out.join("");
}


/** The INVERSE of blankCommentsAndRegex: keep comment text, blank everything else. Positions and
 *  newlines are preserved so line numbers still line up.
 *
 *  A rule that hunts TODO markers must read comments and ONLY comments. Given the whole raw line it also
 *  matches the word inside a string - which is how a table of lint rules and a prompt forbidding TODOs
 *  both reported themselves as containing one. */
export function commentsOnly(src: string): string {
  const s = String(src ?? "");
  const out: string[] = s.split("").map((c) => (c === "\n" ? "\n" : " "));
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") { while (i < n && s[i] !== "\n") { out[i] = s[i]; i++; } continue; }
    if (c === "/" && d === "*") { while (i < n && !(s[i] === "*" && s[i + 1] === "/")) { out[i] = s[i]; i++; } if (i < n) { out[i] = s[i]; out[i + 1] = s[i + 1]; i += 2; } continue; }
    if (c === '"' || c === "'" || c === "`") { // skip string bodies entirely
      const q = c; i++;
      while (i < n) { if (s[i] === "\\") { i += 2; continue; } if (s[i] === q) { i++; break; } i++; }
      continue;
    }
    i++;
  }
  return out.join("");
}

/* ───────────────────────────── scope extraction ─────────────────────────────
   Walk OUTWARD from the error line. Each time brace depth drops below the
   current floor, the line that dropped it opens an enclosing scope; record what
   that scope is and which identifiers it declares before the error point. This
   is the honest form of "locals up the call stack": names and declaration
   sites, which are in the source, rather than values, which are not.           */

/** `for (…) {`, `if (…) {`, `catch (e) {` all match a bare call-shaped pattern. Without this they were
 *  reported as methods named "for"/"if", with the loop header parsed as a parameter list. */
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "do", "else", "try", "return", "typeof", "with"]);

const FN_PATTERNS: [RegExp, string][] = [
  [/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/, "function"],
  [/\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/, "method"],
  [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/, "arrow"],
  [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/, "arrow"],
  [/\bclass\s+([A-Za-z_$][\w$]*)/, "class"],
];

const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|\bfunction\s+([A-Za-z_$][\w$]*)|\bclass\s+([A-Za-z_$][\w$]*)/g;

export function scopeChainAt(src: string, line: number, maxDepth = 6): ScopeInfo {
  const code = blankNonCode(src);
  const lines = code.split("\n");
  const rawLines = String(src ?? "").split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, line - 1));

  // Depth at the START of each line.
  const depthAt: number[] = new Array(lines.length);
  let d = 0;
  for (let i = 0; i < lines.length; i++) {
    depthAt[i] = d;
    for (const ch of lines[i]) { if (ch === "{") d++; else if (ch === "}") d--; }
  }

  const chain: ScopeInfo["chain"] = [];
  let floor = depthAt[idx];
  for (let i = idx - 1; i >= 0 && chain.length < maxDepth; i--) {
    if (depthAt[i] >= floor) continue;
    floor = depthAt[i];
    const text = rawLines[i] ?? "";
    let kind = "block", name = "(anonymous)", params: string[] = [];
    for (const [re, k] of FN_PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      const nm = (m[1] || "").trim();
      if (CONTROL.has(nm)) { kind = nm === "catch" ? "catch" : nm === "for" || nm === "while" || nm === "do" ? "loop" : "block"; name = nm; params = []; break; }
      kind = k;
      name = nm || "(anonymous)";
      params = k === "class" ? [] : String(m[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      break;
    }
    // Identifiers THIS scope declares - at its own body depth only. Scanning every line between the
    // opener and the error line pulled in declarations from nested blocks, so an outer function was
    // reported as declaring an inner function's locals. That is worse than reporting nothing: it points
    // the model at a variable that does not exist where it thinks it does.
    const bodyDepth = floor + 1;
    const declares = new Set<string>();
    for (let j = i; j < idx; j++) {
      if (j > i && depthAt[j] !== bodyDepth) continue;
      DECL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DECL.exec(lines[j] ?? "")) !== null) {
        const id = m[1] || m[2] || m[3];
        if (id) declares.add(id);
      }
    }
    for (const p of params) declares.add(p.replace(/[=:].*$/, "").replace(/^\.\.\./, "").trim());
    chain.push({ kind, name, params, line: i + 1, declares: [...declares].filter(Boolean).slice(0, 40) });
    if (floor <= 0) break;
  }
  return { chain };
}

/* ─────────────────────────────── enrichment ─────────────────────────────── */

export function sourceWindow(src: string, line: number, radius = 6): [number, string][] {
  const lines = String(src ?? "").split("\n");
  const from = Math.max(1, line - radius), to = Math.min(lines.length, line + radius);
  const out: [number, string][] = [];
  for (let i = from; i <= to; i++) out.push([i, lines[i - 1] ?? ""]);
  return out;
}

export function enrichFrames(frames: Frame[], files: ArtFile[], radius = 6): EnrichedFrame[] {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  return frames.map((fr) => {
    const src = byPath.get(fr.file);
    if (!src || !fr.line) return { ...fr, window: [], caret: null, scope: null, resolved: false };
    return {
      ...fr,
      window: sourceWindow(src, fr.line, radius),
      caret: fr.col > 0 ? " ".repeat(Math.max(0, fr.col - 1)) + "^" : null,
      scope: scopeChainAt(src, fr.line),
      resolved: true,
    };
  });
}

/** Own enumerable properties of a thrown value, plus the standard non-enumerables worth having. */
export function errorProps(e: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!e || typeof e !== "object") return out;
  for (const k of Object.keys(e as object)) {
    if (k === "stack" || k === "message") continue;
    try { out[k] = clampValue((e as any)[k]); } catch { out[k] = "(threw on access)"; }
  }
  for (const k of ["name", "code", "status", "fileName", "lineNumber"]) {
    const v = (e as any)[k];
    if (v !== undefined && !(k in out)) out[k] = clampValue(v);
  }
  return out;
}

export function causeChain(e: unknown, max = 5): string[] {
  const out: string[] = [];
  let cur: any = e;
  for (let i = 0; i < max && cur && typeof cur === "object" && "cause" in cur; i++) {
    cur = cur.cause;
    if (cur == null) break;
    out.push(String(cur?.message ?? cur));
  }
  return out;
}

function clampValue(v: unknown, depth = 0): unknown {
  if (v == null) return v;
  const t = typeof v;
  if (t === "string") return (v as string).length > 300 ? (v as string).slice(0, 300) + `… (${(v as string).length} chars)` : v;
  if (t === "number" || t === "boolean") return v;
  if (t === "function") return `[function ${(v as any).name || "anonymous"}]`;
  if (depth >= 2) return "[nested]";
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => clampValue(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).slice(0, 20)) { try { o[k] = clampValue((v as any)[k], depth + 1); } catch { o[k] = "(threw)"; } }
  return o;
}

/* ──────────────────────────────── formatting ──────────────────────────────── */

const pad = (n: number, w: number) => String(n).padStart(w, " ");

/** The text handed to the model. Compact on purpose: this rides in a prompt, so every line must earn
 *  its tokens. Unresolved frames are still listed - a gap in the chain is information. */
export function formatReport(r: ErrorReport, opts: { maxFrames?: number } = {}): string {
  const maxFrames = opts.maxFrames ?? 4;
  const L: string[] = [];
  L.push(`${r.kind.toUpperCase()}: ${r.message}`);
  if (r.causes.length) L.push(`caused by: ${r.causes.join(" <- ")}`);
  const props = Object.keys(r.props);
  if (props.length) L.push(`error properties: ${JSON.stringify(r.props)}`);
  if (r.state) L.push(`page state at throw: ${JSON.stringify(r.state)}`);

  const shown = r.frames.slice(0, maxFrames);
  shown.forEach((f, i) => {
    L.push("");
    L.push(`#${i} ${f.fn} — ${f.file || "(unknown file)"}:${f.line}:${f.col}${f.resolved ? "" : "   [source not in this artifact]"}`);
    if (f.resolved) {
      const w = String(f.window[f.window.length - 1]?.[0] ?? 0).length;
      for (const [ln, text] of f.window) {
        L.push(`${ln === f.line ? ">" : " "} ${pad(ln, w)} | ${text}`);
        if (ln === f.line && f.caret) L.push(`  ${" ".repeat(w)} | ${f.caret}`);
      }
      const chain = f.scope?.chain ?? [];
      if (chain.length) {
        L.push(`  scope chain (innermost first) — names only; JS cannot expose frame values:`);
        for (const s of chain) {
          const sig = s.params.length ? `${s.name}(${s.params.join(", ")})` : s.name;
          L.push(`    ${s.kind} ${sig} @${s.line}${s.declares.length ? ` declares: ${s.declares.join(", ")}` : ""}`);
        }
      }
    }
  });
  if (r.frames.length > shown.length) L.push(`\n(+${r.frames.length - shown.length} more frames)`);
  return L.join("\n");
}

/** Several reports plus the lint findings, deduplicated, as one repair brief. */
export function formatRepairBrief(reports: ErrorReport[], lint: string[], opts: { maxErrors?: number } = {}): string {
  const maxErrors = opts.maxErrors ?? 5;
  const seen = new Set<string>();
  const uniq = reports.filter((r) => {
    const k = `${r.kind}|${r.message}|${r.frames[0]?.file}:${r.frames[0]?.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, maxErrors);
  const L: string[] = [];
  if (uniq.length) {
    L.push(`${uniq.length} runtime error${uniq.length > 1 ? "s" : ""} captured from the running page:`);
    L.push("");
    uniq.forEach((r, i) => { L.push(`═══ error ${i + 1} of ${uniq.length} ═══`); L.push(formatReport(r)); L.push(""); });
  }
  if (lint.length) {
    L.push(`${lint.length} static issue${lint.length > 1 ? "s" : ""} from the cross-file lint:`);
    for (const i of lint.slice(0, 30)) L.push(`  - ${i}`);
  }
  if (!L.length) return "";
  L.push("");
  L.push("Fix the causes, not the symptoms. Change only what these findings implicate; do not rewrite working files.");
  return L.join("\n");
}

/** Build a report from a raw payload posted by the page's console hook. */
export function buildReport(payload: {
  message?: string;
  kind?: string;
  stack?: string;
  props?: Record<string, unknown>;
  causes?: string[];
  state?: Record<string, unknown> | null;
}, files: ArtFile[]): ErrorReport {
  const known = files.map((f) => f.path);
  return {
    message: String(payload.message ?? "(no message)").slice(0, 1000),
    kind: String(payload.kind ?? "error"),
    frames: enrichFrames(parseStack(String(payload.stack ?? ""), known), files),
    props: payload.props && typeof payload.props === "object" ? payload.props : {},
    causes: Array.isArray(payload.causes) ? payload.causes.map(String).slice(0, 5) : [],
    state: payload.state && typeof payload.state === "object" ? payload.state : null,
    at: Date.now(),
  };
}
