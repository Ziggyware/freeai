// Durable bug/feature backlog (the `issue` table in db.ts) — agent tool functions plus a small read endpoint.
//
// Previously reported bugs and requested features existed only as prose inside chat history: not queryable
// ("what's still open for artifact #12, sorted by priority"), and not reliable across a long or compacted
// conversation — an old report can silently scroll out of the context window a model reads, or get folded
// into a lossy running summary by app-compact.ts. These tools give the model a durable place to write down
// what it found (or was told) and read it back later, in this session or a future one, instead of depending
// on the item still being visible in recent chat turns.
import { all, one, run, sql, unwrap } from "./db.ts";

// Local structural types instead of importing app.tsx's Tool/ToolCtx — mirrors app-swarm.ts's SwarmDeps
// pattern (see its header comment): avoids a runtime import cycle back into app.tsx, and TypeScript's
// structural typing means these satisfy app.tsx's own Tool/ToolCtx shapes without needing to share the type.
type ToolCtx = { session: string; turn?: { artifactId?: number } };
type Tool = { schema: Record<string, unknown>; handle: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown> };

const KINDS = ["bug", "feature"] as const;
const STATUSES = ["open", "in_progress", "fixed", "wontfix", "duplicate"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
type Status = (typeof STATUSES)[number];

export const ISSUE_TOOLS: Record<string, Tool> = {
  log_issue: {
    schema: {
      type: "function",
      function: {
        name: "log_issue",
        description:
          "Record a bug or feature request in the durable backlog so it survives this turn and can be found again later — by you in a future session, or a human reviewing progress. Call this whenever the user reports something broken, asks for something to be added later rather than now, or you notice a defect while working that you are not fixing immediately. Do not use it for something you are about to fix right now in this same turn — just fix it.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: KINDS as unknown as string[], description: "bug: something is broken. feature: something new to add." },
            title: { type: "string", description: "One line summary, ≤80 chars." },
            description: { type: "string", description: "What's wrong or wanted, with repro steps / context if it's a bug." },
            priority: { type: "string", enum: PRIORITIES as unknown as string[], description: "Default medium." },
            artifactId: { type: "number", description: "The artifact this concerns, if any. Omit for a session-level or general item." },
          },
          required: ["kind", "title", "description"],
        },
      },
    },
    handle: async ({ kind, title, description, priority, artifactId }, ctx) => {
      const k = String(kind);
      if (k !== "bug" && k !== "feature") return { error: `kind must be "bug" or "feature", got "${k}"` };
      const pRaw = String(priority || "medium");
      const pri = (PRIORITIES as readonly string[]).includes(pRaw) ? pRaw : "medium";
      const aid = Number.isInteger(Number(artifactId)) && Number(artifactId) > 0 ? Number(artifactId) : (ctx.turn?.artifactId ?? null);
      const now = Date.now();
      const r = await run(sql`INSERT INTO issue (session, artifact_id, kind, title, description, status, priority, source, created_ts, updated_ts, resolved_ts, notes)
        VALUES (${ctx.session}, ${aid}, ${k}, ${String(title).slice(0, 200)}, ${String(description).slice(0, 4000)}, 'open', ${pri}, 'model', ${now}, ${now}, NULL, '[]')`);
      if (!r.ok) return { error: r.error };
      const id = r.value.lastInsertRowid === undefined ? null : Number(r.value.lastInsertRowid);
      return { ok: true, id, kind: k, title: String(title).slice(0, 200), priority: pri };
    },
  },
  list_issues: {
    schema: {
      type: "function",
      function: {
        name: "list_issues",
        description:
          "List items in the bug/feature backlog for this session (default: open items only), so work picks up where it left off instead of re-discovering the same problems or forgetting a requested feature.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: [...STATUSES, "all"], description: 'Default "open".' },
            kind: { type: "string", enum: [...KINDS, "all"], description: 'Default "all".' },
            artifactId: { type: "number", description: "Limit to one artifact." },
          },
        },
      },
    },
    handle: async ({ status, kind, artifactId }, ctx) => {
      const st = String(status || "open");
      const kd = String(kind || "all");
      const aid = artifactId != null && Number.isInteger(Number(artifactId)) ? Number(artifactId) : null;
      const rows = unwrap(
        await all(
          "issue",
          sql`SELECT * FROM issue WHERE session = ${ctx.session}
              AND (${st} = 'all' OR status = ${st})
              AND (${kd} = 'all' OR kind = ${kd})
              AND (${aid} IS NULL OR artifact_id = ${aid})
              ORDER BY (priority = 'critical') DESC, (priority = 'high') DESC, created_ts ASC LIMIT 100`,
        ),
        [],
      );
      return {
        count: rows.length,
        issues: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, description: r.description, status: r.status, priority: r.priority, artifactId: r.artifact_id, created: r.created_ts })),
      };
    },
  },
  update_issue: {
    schema: {
      type: "function",
      function: {
        name: "update_issue",
        description:
          "Update a backlog item's status — e.g. after fixing a bug or shipping a feature. Always include a short note saying what actually happened; it's appended to the item's audit trail, not shown as a replacement description.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number", description: "Issue id, from log_issue or list_issues." },
            status: { type: "string", enum: STATUSES as unknown as string[] },
            note: { type: "string", description: "What changed — required." },
          },
          required: ["id", "status", "note"],
        },
      },
    },
    handle: async ({ id, status, note }) => {
      const iid = Number(id);
      const st = String(status);
      if (!(STATUSES as readonly string[]).includes(st)) return { error: `status must be one of ${STATUSES.join(", ")}` };
      const cur = unwrap(await one("issue", sql`SELECT * FROM issue WHERE id = ${iid}`), null);
      if (!cur) return { error: `no issue with id ${iid}` };
      let notes: unknown[] = [];
      try { notes = JSON.parse(cur.notes || "[]"); } catch { /* corrupt/empty — start fresh rather than fail the update */ }
      notes.push({ ts: Date.now(), text: String(note).slice(0, 1000) });
      const resolvedTs = (st === "fixed" || st === "wontfix" || st === "duplicate") ? Date.now() : null;
      await run(sql`UPDATE issue SET status = ${st as Status}, updated_ts = ${Date.now()}, resolved_ts = ${resolvedTs}, notes = ${JSON.stringify(notes).slice(0, 8000)} WHERE id = ${iid}`);
      return { ok: true, id: iid, status: st };
    },
  },
};

/** GET ?issues=list&session=S[&status=open][&kind=bug][&artifactId=N] → the same backlog, for non-tool (UI/debug) callers. */
export async function handleIssues(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET" || url.searchParams.get("issues") !== "list") return null;
  const session = String(url.searchParams.get("session") ?? "");
  if (!session) return Response.json({ error: { message: "session required" } }, { status: 400 });
  const st = String(url.searchParams.get("status") ?? "open");
  const kd = String(url.searchParams.get("kind") ?? "all");
  const aidParam = url.searchParams.get("artifactId");
  const aid = aidParam != null && Number.isInteger(Number(aidParam)) ? Number(aidParam) : null;
  const rows = unwrap(
    await all(
      "issue",
      sql`SELECT * FROM issue WHERE session = ${session}
          AND (${st} = 'all' OR status = ${st})
          AND (${kd} = 'all' OR kind = ${kd})
          AND (${aid} IS NULL OR artifact_id = ${aid})
          ORDER BY (priority = 'critical') DESC, (priority = 'high') DESC, created_ts ASC LIMIT 200`,
    ),
    [],
  );
  return Response.json({ issues: rows });
}
