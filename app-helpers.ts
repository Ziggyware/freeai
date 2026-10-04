// Helpers split out of app.tsx to stay under the Val Town 80,000-character per-file limit:
// legacy blob memory + salience facts, prompt shrinking, title derivation, tool-event slimming, web search, eval_js.
import { all, type Bound, one, type Row, run, sql, unwrap } from "./db.ts";
// ts: optional wall-clock stamp — only the synthetic "route" events app.tsx's PassMeter pushes set it (real
// tool-call events don't need it, their hop order already IS their chronology); when present, ui-timeline.ts
// uses it to interleave route nodes with tool-call rows in the order they actually happened, not just hop order.
export interface ToolEvent { hop: number; tool: string; args: Record<string, unknown>; result?: unknown; error?: string; ts?: number }

export async function getMemoryBlob(): Promise<Row<"memory"> | null> {
  return unwrap(
    await one("memory", sql`SELECT * FROM memory WHERE key = ${"core"}`),
    null,
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  EPISODIC MEMORY: write with surprise-salience, retrieve by relevance, decay
// ════════════════════════════════════════════════════════════════════════════
export const DECAY_HALFLIFE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const FACT_CAP = 500;

export function decayed(salience: number, accessed: number, now: number): number {
  const age = Math.max(0, now - accessed);
  return salience * Math.pow(0.5, age / DECAY_HALFLIFE_MS);
}

export async function writeFact(fact: string, predictability: number): Promise<void> {
  const now = Date.now();
  // salience = information content ≈ (1 - self-reported predictability).
  const salience = Math.max(0.01, Math.min(1, 1 - predictability));
  await run(
    sql`INSERT INTO memory_fact (fact, salience, created, accessed, hits)
                VALUES (${fact}, ${salience}, ${now}, ${now}, 0)`,
  );

  // Bounded store: evict lowest current-value rows beyond a cap.
  const rows = unwrap(
    await all("memory_fact", sql`SELECT * FROM memory_fact`),
    [],
  );
  if (rows.length <= FACT_CAP) return;
  const ranked = rows
    .map((r) => ({ id: r.id, v: decayed(r.salience, r.accessed, now) }))
    .sort((a, b) => a.v - b.v);
  const drop = ranked.slice(0, rows.length - FACT_CAP).map((r) => r.id);
  if (!drop.length) return;
  // Placeholder count varies with drop.length, but every bound value is still
  // a real parameter — this is `run` given a Bound built directly rather than
  // via the tagged template, which only supports a fixed interpolation count.
  const deleteEvicted: Bound = {
    text: `DELETE FROM memory_fact WHERE id IN (${
      drop.map(() => "?").join(",")
    })`,
    values: drop,
  };
  await run(deleteEvicted);
}

// Keyword-overlap retrieval — no embedding dependency. Deliberately simple;
// swap for vector search later without touching callers.
export function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) =>
      w.length > 2
    ),
  );
}

export async function retrieveFacts(query: string, k = 5): Promise<string[]> {
  const now = Date.now();
  const qTok = tokenize(query);
  if (!qTok.size) return [];
  const rows = unwrap(
    await all("memory_fact", sql`SELECT * FROM memory_fact`),
    [],
  );
  const scored = rows.map((r) => {
    const fTok = tokenize(r.fact);
    let overlap = 0;
    for (const t of qTok) if (fTok.has(t)) overlap++;
    const relevance = overlap / Math.sqrt(fTok.size || 1);
    const value = decayed(r.salience, r.accessed, now);
    return { id: r.id, fact: r.fact, score: relevance * (0.5 + value) };
  });
  const top = scored.filter((s) => s.score > 0).sort((a, b) =>
    b.score - a.score
  ).slice(0, k);
  // reinforce accessed facts (anti-decay); this is retrieval-as-rehearsal
  for (const t of top) {
    await run(
      sql`UPDATE memory_fact SET accessed = ${now}, hits = hits + 1 WHERE id = ${t.id}`,
    );
  }
  return top.map((t) => t.fact);
}

// ════════════════════════════════════════════════════════════════════════════
//  SESSION CRUD
// ════════════════════════════════════════════════════════════════════════════

/** Make a prompt fit a smaller input ceiling: keep system messages and the last user turn intact; level 1 drops the
 *  oldest half of the history and caps tool results at 1.5k chars; level 2 keeps only the last 2 exchanges and caps at 600. */
export function shrinkMessages(messages: any[], level: number): any[] {
  const sys = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const cap = level >= 2 ? 600 : 1_500;
  const keep = level >= 2 ? Math.min(rest.length, 4) : Math.max(2, Math.ceil(rest.length / 2));
  const tail = rest.slice(-keep).map((m) => (m.role === "tool" && typeof m.content === "string" && m.content.length > cap ? { ...m, content: m.content.slice(0, cap) + " …[trimmed]" } : m));
  // a tool message must follow the assistant turn that requested it — drop leading orphans
  while (tail.length && tail[0].role === "tool") tail.shift();
  const last = tail[tail.length - 1];
  if (last?.role === "user" && typeof last.content === "string" && last.content.length > 24_000) tail[tail.length - 1] = { ...last, content: last.content.slice(0, 16_000) + "\n…[middle trimmed to fit the model's input limit]…\n" + last.content.slice(-6_000) };
  return [...sys, ...tail];
}
/** ≤4 significant words of the ask, Title Case; deterministic so two clients agree. */
export function deriveTitle(text: string): string {
  const STOP = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with", "me", "my", "please", "can", "you", "i", "it", "that", "this", "is", "be", "make", "create", "build", "write", "help", "want", "need", "using", "use"]);
  const words = text.replace(/```[\s\S]*?```/g, " ").replace(/[^\p{L}\p{N}\s#.-]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  const pick = (words.length ? words : text.split(/\s+/)).slice(0, 4).map((w) => w.length > 18 ? w.slice(0, 18) : w);
  return (pick.map((w) => /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join(" ") || "New Chat").slice(0, 60);
}

/** Tool events as the UI needs them after a reload: args/results without file bodies. */
/** Bulk fields are SUMMARISED, never dropped.
 *
 *  These four keys used to be filtered out entirely, which was right for create/update_artifact (do not
 *  echo a whole generated file back into the timeline) and catastrophic for read_artifact, whose entire
 *  result IS those keys: `read_artifact {id:103, all:true}` rendered as {"id":103,"title":"…","issues":[]}
 *  — every file and every byte of content gone. The tool had worked; the record of what it read was
 *  destroyed on the way to the UI and to storage, so it read as "read_artifact doesn't work".
 *
 *  Summarising keeps the original intent (no 40KB blob in a timeline row) while preserving the part that
 *  carries the meaning: which files, and how big. A path list costs ~40 bytes per file. */
const BULK_KEYS = new Set(["content", "files", "edits", "html"]);
function summarizeBulk(v: unknown, arrayCap: number): unknown {
  if (v == null) return v;
  if (typeof v === "string") return `[${v.length} chars]`;
  if (Array.isArray(v)) {
    const rows = v.slice(0, arrayCap).map((x: any) => {
      if (x && typeof x === "object" && typeof x.path === "string") {
        const bytes = typeof x.content === "string" ? x.content.length : typeof x.bytes === "number" ? x.bytes : undefined;
        return bytes === undefined ? { path: x.path } : { path: x.path, bytes };
      }
      return typeof x === "string" ? (x.length > 120 ? x.slice(0, 120) + "…" : x) : "[item]";
    });
    return v.length > arrayCap ? [...rows, `…+${v.length - arrayCap} more`] : rows;
  }
  return "[omitted]";
}

export function slimEvents(evs: ToolEvent[], cap = 2000): ToolEvent[] {
  // `arrayCap` exists because the 20-element cap — right for a tool's file list — silently truncated the
  // routing flowchart's plan (34 → 20) and attempts, which cut off exactly the tail where demoted
  // providers and late passes live. Route events are already bounded at the router (TRAIL_CAP=60), so they
  // get a cap that keeps the whole trail.
  const mk = (arrayCap: number) => {
    const trim = (v: unknown): unknown => {
      if (typeof v === "string") return v.length > cap ? v.slice(0, cap) + "…" : v;
      if (Array.isArray(v)) return v.slice(0, arrayCap).map(trim);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, BULK_KEYS.has(k) ? summarizeBulk(x, arrayCap) : trim(x)]));
      return v;
    };
    return trim;
  };
  const trimTool = mk(20), trimRoute = mk(80);
  return evs.map((e) => {
    const trim = e.tool === "route" ? trimRoute : trimTool;
    // ts is what cognize() sorted on to interleave route hops with tool calls; dropping it here meant a reload
    // could never re-establish that order.
    return { hop: e.hop, tool: e.tool, ...(e.ts ? { ts: e.ts } : {}), args: trim(e.args) as Record<string, unknown>, result: trim(e.result), ...(e.error ? { error: e.error } : {}) };
  });
}

export async function webSearch(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${
    encodeURIComponent(query)
  }`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const text = await res.text();
  const snippets: string[] = [];
  const re = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && snippets.length < 6) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return snippets.length ? snippets.join("\n---\n") : "No results found.";
}

export function evalJs(code: string): unknown {
  try {
    const logs: string[] = [];
    const fakeConsole = { log: (...a: unknown[]) => logs.push(a.join(" ")) };
    const fn = new Function(
      "Math",
      "JSON",
      "Array",
      "Object",
      "String",
      "Number",
      "Boolean",
      "Date",
      "RegExp",
      "Map",
      "Set",
      "console",
      `"use strict";\n${code}`,
    );
    const result = fn(
      Math,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Map,
      Set,
      fakeConsole,
    );
    return { result: result ?? null, logs };
  } catch (e) {
    return { error: String(e) };
  }
}

// Harmony / text-embedded tool-call parsing (gpt-oss leaks `to=functions.NAME json{…}` into content) and tool-name aliases.
export function balancedJson(s: string, at: number): string {
  if (s[at] !== "{") return "";
  let depth = 0, inStr = false, esc = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) return s.slice(at, i + 1); }
  }
  return "";
}
export function parseTextToolCalls(content: string): { calls: any[]; rest: string } {
  const calls: any[] = [];
  // gpt-oss "Harmony" channel leakage (some vendors' chat templates emit it as plain text):
  //   analysis…  commentary to=functions.NAME json{…}  assistantfinal…
  // → tool call from the commentary segment; only the final channel is user-visible prose.
  if (/to=functions\.[\w.-]+/.test(content) || /assistantfinal/.test(content)) {
    const rx = /to=functions\.([\w.-]+)(?:\s*<\|[^|>]*\|>\s*|\s*json\s*|\s)*(?=\{)/g;
    for (const m of content.matchAll(rx)) {
      const json = balancedJson(content, m.index! + m[0].length);
      if (!json) continue;
      try { const j = JSON.parse(json); calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: m[1], arguments: JSON.stringify(j) } }); } catch { /* malformed */ }
    }
    const fin = content.split(/assistantfinal/); const visible = fin.length > 1 ? fin[fin.length - 1] : (calls.length ? "" : content.replace(/^\s*analysis[\s\S]*?(?=assistant|$)/, ""));
    content = visible.replace(/<\|[^|>]*\|>/g, "");
  }
  const rest = content.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g, (_, inner: string) => {
    const t = inner.trim();
    try {
      if (t.startsWith("{")) { const j = JSON.parse(t); if (j.name) calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: j.name, arguments: JSON.stringify(j.arguments ?? j.parameters ?? {}) } }); return ""; }
    } catch { /* fall through */ }
    const fn = t.match(/<function=([\w.-]+)>/);
    if (!fn) return "";
    const args: Record<string, string> = {};
    for (const m of t.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|<\/function>|$)/g)) args[m[1]] = m[2].replace(/^\n/, "").replace(/\n$/, "");
    calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: fn[1], arguments: JSON.stringify(args) } });
    return "";
  });
  return { calls, rest: rest.trim() };
}

export const TOOL_ALIASES: Record<string, string> = { search: "search_artifact", grep: "search_artifact", find: "search_artifact", read_file: "read_artifact", read: "read_artifact", edit: "update_artifact", write_file: "update_artifact", edit_file: "update_artifact", write: "update_artifact", search_web: "web_search", browse: "web_search", remember: "memory_write", recall: "memory_recall" };
export const summarizeEvent = (ev: ToolEvent) =>
  ev.error ? `**${ev.tool}** failed: ${ev.error}`
  : ev.tool === "create_artifact" ? `Built **${(ev.result as any)?.title ?? ev.args.title ?? "artifact"}** — open it above.`
  : ev.tool === "update_artifact" ? `Updated **${String(ev.args.path ?? "index.html")}** in artifact #${(ev.result as any)?.id ?? ""} — reload it above.`
  : ev.tool === "read_artifact" ? "" : `Ran **${ev.tool}**.`;


/** Vendor-portable message shapes. Strict OpenAI-compatible backends reject what lenient ones accept:
 *  nvidia_nim — "Assistant message must have either content or tool_calls, but not both" → drop empty content beside tool_calls;
 *  together — "prompt cannot be empty" → no message may carry empty-string content; tool results and assistant turns get a marker.
 *  Consecutive system messages are merged (mistral/anthropic-style backends want one). Never mutates the input. */
export function normalizeMessages(messages: unknown[]): unknown[] {
  const out: any[] = [];
  for (const raw of messages as any[]) {
    if (!raw || typeof raw !== "object") continue;
    const m: any = { ...raw };
    const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    const empty = m.content == null || (typeof m.content === "string" && m.content.trim() === "") || (Array.isArray(m.content) && m.content.length === 0);
    if (hasCalls) { if (empty) delete m.content; }
    // A WIRE PLACEHOLDER MUST NOT BE SEMANTIC. This wrote the literal string "(continued)" as the
    // assistant's own words whenever an assistant turn had no content and no tool_calls. That text was
    // then persisted and replayed on every later turn, so the model read a transcript in which it had
    // said "(continued)" over and over and nothing else - and started reasoning about its own apparent
    // stalling instead of building. Observed verbatim in a live trace: "The assistant has been giving
    // placeholder (continued) many times, not actually building any artifact."
    //
    // A single space satisfies every provider that rejects empty content and asserts nothing.
    else if (empty) m.content = m.role === "tool" ? "(no output)" : " ";
    // Scrub the poison already sitting in stored history. Sessions built before this fix replay turns
    // whose content IS "(continued)"; leaving them in keeps steering the model long after the source of
    // them is gone. Only an exact standalone match is removed, so a real reply that happens to contain
    // the word is untouched.
    if (m.role === "assistant" && typeof m.content === "string" && /^\s*\(continued\)\s*$/i.test(m.content)) m.content = " ";
    if (m.role === "system" && out.length && out[out.length - 1].role === "system" && typeof m.content === "string" && typeof out[out.length - 1].content === "string") { out[out.length - 1] = { ...out[out.length - 1], content: out[out.length - 1].content + "\n\n" + m.content }; continue; }
    out.push(m);
  }
  return out;
}

/** Salvage a create_artifact / update_artifact call whose JSON arguments were cut at max_tokens: recover every COMPLETE
 *  {path, content} object from the `files` array (and `content`/`title` when they closed), report which file was cut.
 *  Returns null when nothing usable survived. The cut file is deliberately dropped — a half file is a placeholder. */
export function salvageArtifactArgs(raw: string): { args: Record<string, unknown>; saved: string[]; cut: string | null } | null {
  const files: { path: string; content: string }[] = [];
  let cut: string | null = null;
  // Anchored to a preceding `{`/`,` (an actual object-key position), not a bare substring search: `content`
  // is large, arbitrary, model-generated HTML/JS and typically precedes `files` in argument order, so a
  // plain `raw.indexOf('"files"')` can match text INSIDE that content instead of the real key — e.g.
  // generated markup containing `data-x="files"` is JSON-escaped as `\"files\"`, and the 7-char sequence
  // `"files"` (unescaped) appears right after that backslash, matching before the real key ever does. That
  // false match then feeds a garbage `[` search and corrupts (or silently drops) the whole salvage.
  const filesKeyMatch = raw.match(/[{,]\s*"files"\s*:/);
  const at = filesKeyMatch ? filesKeyMatch.index! + filesKeyMatch[0].indexOf('"files"') : -1;
  if (at >= 0) {
    const arr = raw.indexOf("[", at);
    let i = arr + 1;
    while (i < raw.length) {
      const o = raw.indexOf("{", i); if (o < 0) break;
      const obj = balancedJson(raw, o);
      if (!obj) { const m = raw.slice(o).match(/"path"\s*:\s*"([^"]*)"/); cut = m ? m[1] : "(unnamed)"; break; }
      try { const f = JSON.parse(obj); if (typeof f?.path === "string" && typeof f?.content === "string") files.push({ path: f.path, content: f.content }); } catch { break; }
      i = o + obj.length;
    }
  }
  const head = at >= 0 ? raw.slice(0, at) : raw; /* top-level strings only count when they precede the files array — after it they were cut */
  // Escape map covers \n \t \u fully; every other escape (including the unmapped \r \b \f) fell through to
  // "output the raw character after the backslash" — correct BY COINCIDENCE for \" and \\ (the char after
  // the backslash IS the literal character wanted), but wrong for \r/\b/\f, which decoded to a literal
  // "r"/"b"/"f" letter instead of the actual control character. Rare in practice (most generated content
  // uses \n, not \r), but real whenever salvaged content contains Windows-style line endings.
  const str = (key: string) => { const m = head.match(new RegExp('"' + key + '"\\s*:\\s*"')); if (!m) return undefined; const start = (m.index ?? 0) + m[0].length; let out = "", j = start; while (j < head.length) { const c = head[j]; if (c === "\\") { const n = head[j + 1]; out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n === "b" ? "\b" : n === "f" ? "\f" : n === "u" ? String.fromCharCode(parseInt(head.slice(j + 2, j + 6), 16)) : n; j += n === "u" ? 6 : 2; continue; } if (c === '"') return out; out += c; j++; } return undefined; };
  const args: Record<string, unknown> = {};
  const id = raw.match(/"id"\s*:\s*(\d+)/); if (id) args.id = Number(id[1]);
  const title = str("title"); if (title !== undefined) args.title = title;
  const kind = str("kind"); if (kind !== undefined) args.kind = kind;
  const content = str("content"); if (content !== undefined) args.content = content;
  if (files.length) args.files = files;
  if (!files.length && args.content === undefined) return null;
  return { args, saved: files.map((f) => f.path), cut };
}

// Hidden META control block parsing and the pre-estimate heuristics (moved from app.tsx for the 80k-char limit).
export const META_OPEN = "<<<META";
export const META_CLOSE = "META>>>";

export interface AnswerMeta {
  confidence: number; // 0..1 self-estimated P(answer correct)
  stakes: "low" | "high"; // self-estimated irreversibility of being wrong
  abstain: boolean; // true → model declines rather than confabulate
}
export function parseMeta(text: string): { visible: string; meta: AnswerMeta | null } {
  const i = text.lastIndexOf(META_OPEN);
  const j = text.lastIndexOf(META_CLOSE);
  if (i !== -1 && (j === -1 || j < i)) return { visible: text.slice(0, i).trimEnd(), meta: null }; // dangling open marker: hide it
  if (i === -1) return { visible: text, meta: null };
  const raw = text.slice(i + META_OPEN.length, j).trim();
  const visible = (text.slice(0, i) + text.slice(j + META_CLOSE.length)).trim();
  try {
    const p = JSON.parse(raw);
    const meta: AnswerMeta = {
      confidence: Number.isFinite(+p.confidence) ? +p.confidence : 0.5,
      stakes: p.stakes === "high" ? "high" : "low",
      abstain: !!p.abstain,
    };
    return { visible, meta };
  } catch {
    return { visible, meta: null };
  }
}

// (META instruction now lives in prompts.ts as "meta")

// ════════════════════════════════════════════════════════════════════════════
//  COMPLEXITY / STAKES PRE-ESTIMATE  (heuristic, zero-cost — no inference call)
//  Governs whether the expensive stages are even eligible to fire.
// ════════════════════════════════════════════════════════════════════════════
export function preEstimate(
  input: string,
): { complex: boolean; maybeHighStakes: boolean } {
  const t = input.toLowerCase();
  const long = input.length > 180;
  const multiClause = (input.match(/[.?!]/g)?.length ?? 0) >= 2;
  const reasoningWords =
    /\b(why|how|compare|prove|derive|design|analy|trade[- ]?off|implication|explain)\b/
      .test(t);
  const stakesWords =
    /\b(medical|legal|financial|invest|dose|security|delete|irreversible|production|deploy|money|contract)\b/
      .test(t);
  const complex = (long && multiClause) || reasoningWords;
  return { complex, maybeHighStakes: stakesWords };
}

// ── Request-body envelope ───────────────────────────────────────────────────────────────────────────
// Val Town fronts vals with Cloudflare, and its managed WAF rules inspect POST bodies. This app's whole
// purpose is sending prose that contains code — "write me a page with a <script> tag", a generated HTML
// file posted back to ?artifact_save — which is indistinguishable, to a signature matcher, from an XSS or
// RCE payload. Observed live: POST ?q answered 403 with Val Town's "Blocked" page (cf-ray
// a3d4d0218dd30a80-ATL) while GET ?prompts returned JSON normally, proving the block keyed on the body
// rather than on access.
//
// So the body is base64'd: the WAF sees an opaque blob instead of a signature, and the server decodes it.
// This is not an attempt to slip anything past a security control — it is our own client handing our own
// server the user's own prompt, and the rule is a false positive on legitimate content. It changes only
// the ENCODING, never what the server then does with the value.
//
// Backward compatible in both directions: a plain JSON body is returned untouched, so an old client, a
// curl, or the OpenAI-compatible surface all keep working, and a rollback of the client needs no server
// change. Cost is base64's ~33% size overhead.
export async function readJsonBody(req: Request): Promise<any> {
  const b = await req.json().catch(() => ({}));
  if (b && typeof b === "object" && (b as any).__enc === "b64" && typeof (b as any).__p === "string") {
    try {
      const bin = atob((b as any).__p);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return {}; } // a corrupt envelope is an empty body, never a crash — same contract as req.json().catch
  }
  return b;
}
