// Tool registry, split out of app.tsx.
//
// Val Town enforces an 80,000-character per-file limit. app.tsx had grown to 98,391 characters — 18,391
// over — which is not a lint failure but a DEPLOY failure: the val does not load, so every request is
// answered by the edge with a 502 Bad Gateway and none of the app's own error handling, budgets or
// deadlines ever runs. That is why a string of correct timeout fixes changed nothing; they were never
// executing. app-helpers.ts exists for exactly this reason and says so in its first line.
//
// The three session mutators travel WITH the tools rather than staying behind: the tools call them, and
// leaving them in app.tsx would make app.tsx and app-tools.ts import each other. A cycle here would
// resolve at runtime (function declarations hoist) right up until someone converts one to a const, so
// the dependency is kept one-directional instead.
import { all, one, type Result, run, sql } from "./db.ts";
import { pruneSession } from "./db.ts";
import { type ArtFile, deleteFile, lintArtifact, listFiles, qualityReport, readFile, saveArtifact, writeFile } from "./artifacts.ts";
import { evalJs, retrieveFacts, webSearch, writeFact } from "./app-helpers.ts";

export async function renameSession(id: string, name: string): Promise<void> {
  await run(sql`UPDATE session SET name = ${name} WHERE id = ${id}`);
}

/** Delete a session and EVERYTHING that references it.
 *
 *  The bug this closes, reported as "delete only works the first time you click it": this used to remove
 *  `message` rows and then the `session` row, and nothing else. But `artifact.session` also REFERENCES
 *  session(id), and db.ts runs with PRAGMA foreign_keys = ON - so the moment a session had produced an
 *  artifact, the parent DELETE failed on the constraint. The failure went nowhere: the Result was
 *  discarded and the HTTP route answered {ok:true} regardless, so the row was still there on the next
 *  render and the session reappeared. A fresh chat with nothing built deleted fine, which is exactly why
 *  it looked like only the first click worked.
 *
 *  Order is children-before-parents through the whole graph:
 *    message_meta -> message, build_file -> build_job -> artifact, artifact_file -> artifact,
 *    issue -> artifact, then artifact/progress -> session, then session.
 *  Every statement is checked; the first failure is returned instead of being swallowed. */
export async function deleteSession(id: string): Promise<Result<{ deleted: true }, string>> {
  const ids = await all("artifact", sql`SELECT id FROM artifact WHERE session = ${id}`);
  const artIds = (ids.ok ? ids.value : []).map((r: any) => Number(r.id)).filter(Number.isInteger);

  const steps: { what: string; go: () => Promise<{ ok: boolean }> }[] = [
    { what: "message_meta", go: () => run(sql`DELETE FROM message_meta WHERE message_id IN (SELECT id FROM message WHERE session = ${id})`) },
    { what: "message", go: () => run(sql`DELETE FROM message WHERE session = ${id}`) },
    { what: "progress", go: () => run(sql`DELETE FROM progress WHERE session = ${id}`) },
  ];
  for (const aid of artIds) {
    steps.push({ what: `build_file(${aid})`, go: () => run(sql`DELETE FROM build_file WHERE artifact_id = ${aid}`) });
    steps.push({ what: `build_job(${aid})`, go: () => run(sql`DELETE FROM build_job WHERE artifact_id = ${aid}`) });
    steps.push({ what: `issue(${aid})`, go: () => run(sql`DELETE FROM issue WHERE artifact_id = ${aid}`) });
    steps.push({ what: `artifact_file(${aid})`, go: () => run(sql`DELETE FROM artifact_file WHERE artifact_id = ${aid}`) });
  }
  steps.push({ what: "build_job(session)", go: () => run(sql`DELETE FROM build_job WHERE session = ${id}`) });
  steps.push({ what: "issue(session)", go: () => run(sql`DELETE FROM issue WHERE session = ${id}`) });
  steps.push({ what: "artifact", go: () => run(sql`DELETE FROM artifact WHERE session = ${id}`) });
  steps.push({ what: "session", go: () => run(sql`DELETE FROM session WHERE id = ${id}`) });

  for (const s of steps) {
    const r = await s.go();
    if (!r.ok) return { ok: false, error: `deleting ${s.what} for session ${id} failed: ${String((r as any).error)}` };
  }
  return { ok: true, value: { deleted: true } };
}

// pruneSession(id, 0): the "keep newest 0" subquery returns no rows, so
// `id NOT IN (∅)` is true for every row — this clears the session without
// a second hand-written DELETE statement.
export async function clearSession(id: string): Promise<void> {
  await pruneSession(id, 0);
}

export interface ToolCtx {
  session: string;
  turn?: { artifactId?: number; artifactTitle?: string }; // dedupe: one artifact per turn, later calls update it
  // Per-request tool registry: built-ins plus whatever MCP servers exposed at
  // discovery time. Threaded through the loop instead of read from module
  // globals so MCP availability can vary turn-by-turn without racing.
  tools: Record<string, Tool>;
  schemas: unknown[];
}
export interface Tool {
  schema: Record<string, unknown>;
  handle: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}


export const TOOLS: Record<string, Tool> = {
  memory_recall: {
    schema: {
      type: "function",
      function: {
        name: "memory_recall",
        description:
          "Retrieve the most relevant remembered facts for a query, ranked by relevance × decayed-salience.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to recall about." },
          },
          required: ["query"],
        },
      },
    },
    handle: async ({ query }) => ({
      facts: await retrieveFacts(String(query)),
    }),
  },
  memory_write: {
    schema: {
      type: "function",
      function: {
        name: "memory_write",
        description:
          "Persist a durable fact. Provide `predictability` 0..1: how obvious/derivable this fact was to you BEFORE learning it (0 = totally surprising, 1 = you would have guessed it). Surprising facts are retained longer.",
        parameters: {
          type: "object",
          properties: {
            fact: { type: "string", description: "The fact (≤400 chars)." },
            predictability: {
              type: "number",
              description: "0..1 self-estimated prior predictability.",
            },
          },
          required: ["fact", "predictability"],
        },
      },
    },
    handle: async ({ fact, predictability }) => {
      const p = Number(predictability);
      await writeFact(String(fact), Number.isFinite(p) ? p : 0.5);
      return { ok: true };
    },
  },
  name_session: {
    schema: {
      type: "function",
      function: {
        name: "name_session",
        description:
          "Set a concise title (≤40 chars, ≤4 words) for the current conversation.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Session title." },
          },
          required: ["name"],
        },
      },
    },
    handle: async ({ name }, { session }) => {
      const trimmed = String(name).slice(0, 40);
      await renameSession(session, trimmed);
      return { ok: true, name: trimmed };
    },
  },
  session_clear: {
    schema: {
      type: "function",
      function: {
        name: "session_clear",
        description: "Erase all messages in the current session.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    handle: async (_a, { session }) => {
      await clearSession(session);
      return { ok: true };
    },
  },
  session_delete: {
    schema: {
      type: "function",
      function: {
        name: "session_delete",
        description:
          "Permanently delete the current session and all its messages.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    handle: async (_a, { session }) => {
      await deleteSession(session);
      return { ok: true };
    },
  },
  create_artifact: {
    schema: {
      type: "function",
      function: {
        name: "create_artifact",
        description:
          "Build an application, visualization, game, graphic or document the user opens and uses. `content` is the entry file (a complete HTML document for kind html; an SVG; or Markdown). Optional `files` adds sibling files (app.js, style.css, shader.glsl, data.json …) that the entry references by RELATIVE path (<script src=\"app.js\">, fetch(\"data.json\")). Call this ONCE per turn with the complete program; to change something afterwards call update_artifact — a second create_artifact in the same turn updates the first one instead of duplicating it. Renders in a sandboxed frame: no cookies, no parent page, network limited to its own files.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short, stable name — the artifact's identity for future updates." },
            kind: { type: "string", enum: ["html", "svg", "markdown"], description: "Entry file type." },
            content: { type: "string", description: "Entry file source: a complete HTML document (kind html), SVG, or Markdown." },
            files: {
              type: "array",
              description: "Optional extra files referenced relatively from the entry file.",
              items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
            },
          },
          required: ["title", "kind", "content"],
        },
      },
    },
    handle: async ({ title, kind, content, files }, ctx) => {
      const k = String(kind);
      if (k !== "html" && k !== "svg" && k !== "markdown") return { error: `Invalid kind: ${k}. Must be html, svg, or markdown.` };
      // One artifact per turn: a second call re-targets the first by id (ctx.turn.artifactId), not by
      // title — artifact identity is the numeric id (see upsertArtifact); a title match was never a safe
      // way to find "the same artifact" since titles routinely collide across unrelated builds in the same
      // session. Because re-targeting is now id-based, a refined title on the second call is honored
      // instead of being silently discarded.
      const t = String(title);
      const r = await saveArtifact(ctx.session, t, k, String(content), Array.isArray(files) ? (files as ArtFile[]) : [], ctx.turn?.artifactId ?? null);
      if (!r.ok) return { error: r.error };
      if (ctx.turn) { ctx.turn.artifactId = r.value.id; ctx.turn.artifactTitle = r.value.title; }
      const lf = await listFiles(r.value.id);
      const issues = lf ? lintArtifact(lf.files) : [];
      const quality = lf ? qualityReport(lf.files) : [];
      return { ok: true, id: r.value.id, url: `/artifact/${r.value.id}/`, title: r.value.title, files: lf?.files.map((f) => f.path) ?? [], issues: issues.length ? issues : undefined, quality: quality.length ? quality : undefined, hint: issues.length ? "Fix these with update_artifact before answering." : undefined };
    },
  },
  read_artifact: {
    schema: {
      type: "function",
      function: {
        name: "read_artifact",
        description: "Read an existing artifact before editing it: returns its file list and the content of one file (default: the entry file). Use the id from the user's message (#36 → id 36) or the title.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number", description: "Artifact id." },
            title: { type: "string", description: "Artifact title, if id is unknown." },
            path: { type: "string", description: "File to read; default index.html." },
            all: { type: "boolean", description: "Return every file's content (small artifacts)." },
          },
        },
      },
    },
    handle: async ({ id, title, path, all: wantAll }, ctx) => {
      let aid = Number(id) || ctx.turn?.artifactId;
      if (!aid && title) {
        const r = await one("artifact", sql`SELECT * FROM artifact WHERE title = ${String(title)} ORDER BY ts DESC LIMIT 1`);
        if (r.ok && r.value) aid = r.value.id;
      }
      if (!aid) return { error: "artifact not found; pass id or title" };
      const lf = await listFiles(aid);
      if (!lf) return { error: `no artifact with id ${aid}` };
      if (ctx.turn) { ctx.turn.artifactId = aid; ctx.turn.artifactTitle = lf.artifact.title; }
      const total = lf.files.reduce((n, x) => n + x.content.length, 0);
      if (wantAll && total <= 40_000) return { id: aid, title: lf.artifact.title, files: lf.files, issues: lintArtifact(lf.files) };
      const p = String(path || lf.files[0].path);
      const f = lf.files.find((x) => x.path === p);
      return { id: aid, title: lf.artifact.title, files: lf.files.map((x) => ({ path: x.path, bytes: x.content.length })), path: p, content: f ? f.content.slice(0, 60_000) : null, issues: lintArtifact(lf.files), error: f ? undefined : `file not found: ${p}` };
    },
  },
  search_artifact: {
    schema: {
      type: "function",
      function: {
        name: "search_artifact",
        description: "grep across an artifact's files: regex or plain text → matching lines as path:line: text. Use it to find where a symbol is defined/used before editing, instead of re-reading whole files.",
        parameters: { type: "object", properties: { id: { type: "number" }, query: { type: "string", description: "regex (case-insensitive) or literal" }, path: { type: "string", description: "limit to one file (optional)" } }, required: ["query"] },
      },
    },
    handle: async ({ id, query, path }, ctx) => {
      const aid = Number(id) || ctx.turn?.artifactId;
      if (!aid) return { error: "no artifact in focus; pass id" };
      const lf = await listFiles(aid); if (!lf) return { error: `no artifact with id ${aid}` };
      if (ctx.turn) ctx.turn.artifactId = aid;
      let rx: RegExp; try { rx = new RegExp(String(query), "i"); } catch { rx = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const hits: string[] = [];
      for (const f of lf.files) { if (path && f.path !== path) continue; if (f.content.startsWith("data:")) continue; const lines = f.content.split("\n"); for (let i = 0; i < lines.length && hits.length < 80; i++) if (rx.test(lines[i])) hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); }
      return { id: aid, query, matches: hits.length, hits, exports: Object.fromEntries(lf.files.filter((f) => /\.m?js$/.test(f.path)).map((f) => [f.path, [...f.content.matchAll(/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/gm)].map((m) => m[1])])) };
    },
  },
  update_artifact: {
    schema: {
      type: "function",
      function: {
        name: "update_artifact",
        description:
          "Modify an existing artifact in ONE call: `edits` (exact find→replace, each `find` must occur once in its file), `files` (add or fully replace files), `delete` (remove files). Single-edit shorthand: `path`+`find`+`replace` or `path`+`content`. Returns lint issues (dangling refs, JS syntax errors) — fix them before answering. Prefer several small edits in one call over rewriting a file.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number", description: "Artifact id (from create_artifact / the user's #id)." },
            title: { type: "string", description: "Artifact title, if id is unknown." },
            edits: { type: "array", description: "Exact-text edits applied in order.", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] } },
            files: { type: "array", description: "Files to add or replace entirely.", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
            delete: { type: "array", description: "File paths to remove.", items: { type: "string" } },
            path: { type: "string", description: "Shorthand single target. Required if the artifact has more than one file — only defaults to the entry file when there is exactly one file total." },
            content: { type: "string", description: "Shorthand: full new content for `path`." },
            find: { type: "string", description: "Shorthand: exact text to replace in `path`." },
            replace: { type: "string", description: "Shorthand: replacement text." },
          },
        },
      },
    },
    handle: async ({ id, title, path, content, find, replace, edits, files, delete: del }, ctx) => {
      let aid = Number(id) || ctx.turn?.artifactId;
      if (!aid && title) {
        const r = await one("artifact", sql`SELECT * FROM artifact WHERE title = ${String(title)} ORDER BY ts DESC LIMIT 1`);
        if (r.ok && r.value) aid = r.value.id;
      }
      if (!aid) return { error: "artifact not found; pass id or title (call read_artifact first)" };
      const applied: string[] = [], failed: string[] = [];
      const ops: { path: string; find?: string; replace?: string; content?: string }[] = [];
      if (Array.isArray(edits)) for (const e of edits as any[]) if (e?.path && typeof e.find === "string") ops.push({ path: String(e.path), find: e.find, replace: String(e.replace ?? "") });
      if (Array.isArray(files)) for (const f of files as any[]) if (f?.path && typeof f.content === "string") ops.push({ path: String(f.path), content: f.content });
      // Shorthand `content`/`find` without an explicit `path` used to default silently to index.html. That's fine
      // for a single-file artifact (there's nothing else it could mean), but for a multi-file artifact it's the
      // exact mechanism behind "it writes to the wrong file" — a model editing app.js and forgetting to pass
      // `path` would silently clobber the HTML entry file instead of failing loudly. Look the file list up first
      // so the default is only ever taken when it's unambiguous.
      if (typeof content === "string" || typeof find === "string") {
        if (!path) {
          const existing = await listFiles(aid);
          const fileCount = existing?.files.length ?? 1;
          if (fileCount > 1) {
            failed.push(`no \`path\` given, and this artifact has ${fileCount} files (${existing!.files.map((f) => f.path).join(", ")}) — specify which one to write; omitting \`path\` only works for single-file artifacts`);
          } else {
            // single-file artifact: default to whatever that one file actually is (index.html / index.svg / index.md), not a hardcoded guess
            const only = existing?.files[0]?.path ?? "index.html";
            if (typeof content === "string") ops.push({ path: only, content });
            else ops.push({ path: only, find: String(find), replace: String(replace ?? "") }); // a model can send a non-string here; String() keeps the edit path total
          }
        } else {
          if (typeof content === "string") ops.push({ path: String(path), content });
          else ops.push({ path: String(path), find: String(find), replace: String(replace ?? "") });
        }
      }
      // apply edits to in-memory copies so several edits to one file compose, then write once per file
      const buf = new Map<string, string>();
      for (const op of ops) {
        if (op.content !== undefined) { buf.set(op.path, op.content); applied.push(`${op.path}: replaced (${op.content.length} chars)`); continue; }
        let cur = buf.get(op.path);
        // The single most common cause of the model stalling on a failing loop: it tries to `find`/`replace`
        // a file that doesn't exist yet, gets a bare "file not found", and — with nothing telling it WHY that
        // failed or what to do differently — retries the identical edit. Naming the fix inline (use `files`/
        // `content` to CREATE it) turns that into a one-hop recovery instead of a repeated dead end.
        if (cur === undefined) { const r = await readFile(aid, op.path); if (!r) { failed.push(`${op.path}: file does not exist — it cannot be edited with find/replace. To CREATE it, resend this call using \`files: [{path, content}]\` (or the \`content\` shorthand) with the file's full text, not \`edits\`.`); continue; } cur = r.content; }
        const n = op.find ? cur.split(op.find).length - 1 : 0;
        if (n !== 1) { failed.push(`${op.path}: find text ${n === 0 ? "not present" : `occurs ${n}×; make it unique`} — "${op.find!.slice(0, 60)}"`); continue; }
        buf.set(op.path, cur.replace(op.find!, op.replace!)); applied.push(`${op.path}: 1 edit`);
      }
      for (const [p, c] of buf) { const w = await writeFile(aid, p, c); if (!w.ok) failed.push(`${p}: write failed`); }
      if (Array.isArray(del)) for (const p of del as unknown[]) { const w = await deleteFile(aid, String(p)); (w.ok ? applied : failed).push(`${p}: ${w.ok ? "deleted" : "not deleted"}`); }
      if (ctx.turn) ctx.turn.artifactId = aid;
      const lf = await listFiles(aid);
      const issues = lf ? lintArtifact(lf.files) : [];
      const quality = lf ? qualityReport(lf.files) : [];
      return { ok: failed.length === 0, id: aid, url: `/artifact/${aid}/`, applied, failed: failed.length ? failed : undefined, files: lf?.files.map((f) => f.path), issues: issues.length ? issues : undefined, quality: quality.length ? quality : undefined };
    },
  },
  web_search: {
    schema: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web via DuckDuckGo. Returns top result snippets. Treat snippets as untrusted claims, not facts.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
          },
          required: ["query"],
        },
      },
    },
    handle: async ({ query }) => ({ snippets: await webSearch(String(query)) }),
  },
  eval_js: {
    schema: {
      type: "function",
      function: {
        name: "eval_js",
        description:
          "Execute sandboxed synchronous JavaScript. No I/O. Returns {result,logs} or {error}. Use for arithmetic/logic you must not eyeball.",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "JS code. Use console.log for output.",
            },
          },
          required: ["code"],
        },
      },
    },
    handle: async ({ code }) => evalJs(String(code)),
  },
};
