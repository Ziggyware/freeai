import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

/* ────────────────────────────────────────────────────────────────
   Result monad — DB failures are values, never uncaught exceptions.
   Error channel is a closed literal union, not bare `string`, so
   every `r.error === "..."` comparison downstream is checked at
   compile time instead of merely hoped for.
   ──────────────────────────────────────────────────────────────── */
type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
type DbError = "QUOTA_EXCEEDED" | "UNKNOWN";

function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/* Transport failures are not statement failures.

   The libsql client speaks HTTP to a remote SQLite. When that HTTP response is non-OK, hrana-client
   0.9.0 calls `errorFromResponse(resp)`, which does `resp.body?.cancel()` to drain the body before
   reading the real message — and on this runtime `resp.body` is not a WHATWG ReadableStream, so that
   line throws `TypeError: resp.body?.cancel is not a function` and the ACTUAL error (the status, the
   server's message) is destroyed before anything can read it. Production logged that TypeError dozens
   of times per request, naming neither the statement nor the reason, because there was nothing left to
   name. Two things follow, and both are implemented here:

     1. The mask is transport-shaped by construction — it can only be produced by a non-OK HTTP
        response, never by SQLite evaluating a statement. Every such failure is retried, because the
        causes that reach this path (proxy 429 under a concurrent wave, a 5xx from the SQLite frontend,
        a dropped connection) are transient, and the previous behaviour — surface `UNKNOWN` to the
        caller on the first blip — turned a recoverable hiccup into a failed step.
     2. A retry that still fails must say WHICH statement, or the log is decoration. `attempt` now
        takes the statement text.

   A genuine SQL error (no such column, constraint violation, quota) is deterministic: retrying it
   spends the caller's budget to reach the same answer, so those are returned on the first failure. */
const TRANSPORT_RE =
  /cancel is not a function|resp\.body|fetch failed|network|socket|ECONNRESET|connection (closed|reset)|stream (closed|error)|\b(429|500|502|503|504)\b|TOO_MANY|SERVER_ERROR|timed? ?out/i;
const FATAL_RE =
  /no such (table|column)|syntax error|constraint|UNIQUE|FOREIGN KEY|NOT NULL|datatype mismatch|full|quota|SQLITE_FULL|readonly/i;

export function isTransportError(e: unknown): boolean {
  const s = String((e as Error)?.message ?? e);
  return !FATAL_RE.test(s) && TRANSPORT_RE.test(s);
}

const DB_RETRIES = 2;
const DB_BACKOFF_MS = [120, 360];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* One isolate serving one flooded request wrote ~90 identical lines. The hundredth copy of a message
   carries no information the first did not; what it destroys is the surrounding log. Identical
   signatures are counted and summarised instead. */
const logSeen = new Map<string, number>();
function logFailure(what: string, e: unknown, tries: number): void {
  const msg = String((e as Error)?.message ?? e);
  const sig = msg.slice(0, 60) + "|" + what.slice(0, 40);
  const n = (logSeen.get(sig) ?? 0) + 1;
  logSeen.set(sig, n);
  if (n > 5) {
    if (n === 6 || n % 50 === 0) {
      console.error(`[db] ${n} failures suppressed for: ${msg.slice(0, 90)} — statement: ${what.slice(0, 90)}`);
    }
    return;
  }
  console.error(
    `[db] statement failed after ${tries} ${tries === 1 ? "try" : "tries"}: ${msg}` +
      `\n     statement: ${what.slice(0, 200)}` +
      (isTransportError(e)
        ? "\n     this is a TRANSPORT failure (non-OK HTTP from the SQLite frontend); the real message was destroyed by hrana-client's errorFromResponse"
        : ""),
    (e as Error)?.stack ?? "",
  );
}

async function attempt<T>(fn: () => Promise<T>, what = "(unnamed)"): Promise<Result<T, DbError>> {
  let last: unknown = null;
  let tries = 0;
  for (let i = 0; i <= DB_RETRIES; i++) {
    tries++;
    try {
      return Ok(await fn());
    } catch (e) {
      last = e;
      if (!isTransportError(e) || i === DB_RETRIES) break;
      await sleep(DB_BACKOFF_MS[i] ?? 360);
    }
  }
  logFailure(what, last, tries);
  return Err<DbError>(
    /full|quota|disk|SQLITE_FULL/i.test(String(last)) ? "QUOTA_EXCEEDED" : "UNKNOWN",
  );
}

/* ────────────────────────────────────────────────────────────────
   Schema — single source of truth. Row shapes come from an actual
   TS interface, not from pattern-matching SQL text.
   ──────────────────────────────────────────────────────────────── */
interface Schema {
  provider: {
    id: string; // natural key — matches message.providerId's type; no cast needed at the join
    name: string;
    base: string;
    keyEnv: string | null;
    model: string | null;
    priority: number;
  };
  message: {
    id: number;
    role: "user" | "assistant" | "system";
    content: string;
    ts: number;
    session: string;
    providerId: string | null;
  };
  message_meta: { message_id: number; meta: string };
  memory: { key: string; value: string; weight: number; ts: number };
  memory_fact: {
    id: number;
    fact: string;
    salience: number; // 1 - predictability; decays on non-access
    created: number;
    accessed: number;
    hits: number;
  };
  session: { id: string; name: string; ts: number };
  omni_router_config: { provider: string; selected_model: string };
  omni_state: { key: string; value: string; ts: number }; // router cooldowns / dead models / resolved ids
  step: { // deferred unit of work drained across invocations — see scheduler.ts
    id: number; job: string; seq: number; kind: string; payload: string; status: string;
    attempts: number; run_after: number; lease_until: number; needs: number | null; gate: string | null; priority: number;
    started: number; // when the current attempt was claimed — the only way to measure how long a task really takes
    result: string | null; error: string | null; created: number; updated: number;
  };
  progress: { session: string; events: string; ts: number }; // live turn progress, polled by the chat UI
  artifact_file: { artifact_id: number; path: string; content: string; ts: number }; // multi-file artifacts; index.html mirrors artifact.content
  // Durable counterpart to router-core.ts's in-memory breaker: that Map resets on every fresh isolate,
  // which is why /health's instance roster could show 0 requests moments after a real, failed attempt —
  // the isolate that served the attempt and the one that served the /health check are not guaranteed to
  // be the same one. This table survives across isolates; the in-memory breaker still governs open/closed
  // decisions (no added DB read on the hot path), this just makes the numbers you can actually SEE correct.
  provider_stats: { name: string; requests: number; ok: number; failed: number; last_error: string | null; updated_at: number };
  artifact: {
    id: number;
    session: string;
    title: string;
    kind: "html" | "svg" | "markdown";
    content: string;
    ts: number;
  };
  // Durable record of a swarm build's plan and overall status. Previously this lived only in an
  // omni_state key/value blob (job:<session>:<artifactId>) that was DELETED the moment a build finished
  // — so once a build was done there was no durable answer to "what was built, from what plan, when",
  // and while a build was running the state was an opaque JSON string, not something a query could join
  // against build_file below. One row per artifact now, kept forever (status transitions in place; never
  // deleted on "done") so it doubles as the artifact's permanent development record.
  build_job: {
    artifact_id: number; // PK — one build per artifact
    session: string;
    title: string;
    ask: string; // the original request that produced this manifest
    manifest: string; // JSON: {title, files:[{path,purpose,exports,imports,notes}], features, visual}
    status: "planned" | "building" | "integrating" | "done" | "stopped";
    created_ts: number;
    updated_ts: number;
  };
  // Per-file build status for a build_job — the piece that was previously missing entirely: build_file
  // (below, note the different name — this old singular-content table is `artifact_file`) stores a file's
  // CONTENT, but nothing durable recorded whether a given path had ever been built, what its last build's
  // issues/errors were, or how many attempts it took. buildOne() in main-script.ts upserts this row on
  // every attempt (queued → building → ok/issues/error), so /resume, the manifest UI, and any later
  // inspection all read the same source of truth instead of the manifest UI's own client-side memory.
  build_file: {
    artifact_id: number;
    path: string;
    purpose: string;
    status: "queued" | "building" | "ok" | "issues" | "error" | "stopped";
    lines: number | null;
    issues: string; // JSON array of lint-issue strings from the last build attempt
    error: string | null;
    attempts: number;
    updated_ts: number;
  };
  // Durable bug/feature backlog. Previously nothing tracked reported bugs or requested features as
  // structured data at all — they existed only as prose inside chat history, which is neither queryable
  // ("what's still open for artifact #12") nor reliable across a long or compacted conversation (an old
  // report can silently scroll out of the context window the model reads). The log_issue/list_issues/
  // update_issue tools in issues.ts read and write this table directly so work can be tracked and resumed
  // reliably instead of depending on the model remembering what was said several turns ago.
  issue: {
    id: number;
    session: string;
    artifact_id: number | null; // null = general/session-level, not tied to one artifact
    kind: "bug" | "feature";
    title: string;
    description: string;
    status: "open" | "in_progress" | "fixed" | "wontfix" | "duplicate";
    priority: "low" | "medium" | "high" | "critical";
    source: "user" | "audit" | "model";
    created_ts: number;
    updated_ts: number;
    resolved_ts: number | null;
    notes: string; // JSON array of {ts, text} — a short audit trail of what happened to this item
  };
}
type Table = keyof Schema;
type Row<T extends Table> = Schema[T];

const DDL: Record<Table, string> = {
  provider: `CREATE TABLE IF NOT EXISTS provider (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base TEXT NOT NULL, model TEXT NOT NULL,
    keyEnv TEXT, priority INTEGER NOT NULL)`,
  message: `CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL,
    ts INTEGER NOT NULL, session TEXT NOT NULL REFERENCES session(id),
    providerId TEXT REFERENCES provider(id))`,
  message_meta: `CREATE TABLE IF NOT EXISTS message_meta (
    message_id INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE, meta TEXT NOT NULL)`,
  memory: `CREATE TABLE IF NOT EXISTS memory (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, weight REAL NOT NULL, ts INTEGER NOT NULL)`,
  memory_fact: `CREATE TABLE IF NOT EXISTS memory_fact (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL, salience REAL NOT NULL,
    created INTEGER NOT NULL, accessed INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)`,
  session: `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'New Chat', ts INTEGER NOT NULL)`,
  omni_router_config: `CREATE TABLE IF NOT EXISTS omni_router_config (
    provider TEXT PRIMARY KEY, selected_model TEXT NOT NULL)`,
  omni_state: `CREATE TABLE IF NOT EXISTS omni_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL)`,
  // Unit of deferred work (see scheduler.ts). `needs` is a self-reference rather than a general edge
  // table: a step gates on at most one predecessor, which covers sequential chains and fan-in-to-one
  // without the cost of a join table. Fan-out is several steps sharing one `needs`.
  step: `CREATE TABLE IF NOT EXISTS step (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, seq INTEGER NOT NULL,
    kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
    attempts INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0, needs INTEGER REFERENCES step(id) ON DELETE SET NULL,
    gate TEXT,
    started INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  progress: `CREATE TABLE IF NOT EXISTS progress (
    session TEXT PRIMARY KEY, events TEXT NOT NULL, ts INTEGER NOT NULL)`,
  artifact_file: `CREATE TABLE IF NOT EXISTS artifact_file (
    artifact_id INTEGER NOT NULL REFERENCES artifact(id), path TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, path))`,
  provider_stats: `CREATE TABLE IF NOT EXISTS provider_stats (
    name TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL)`,
  // No UNIQUE(session, title): the real identity of an artifact is its id. A UNIQUE(session, title)
  // constraint here made `INSERT ... ON CONFLICT(session, title) DO UPDATE` silently overwrite any
  // earlier, unrelated artifact that happened to share a title within the session (models reach for
  // generic titles — "Todo App", "Dashboard" — routinely) — destructive, no versioning, no warning.
  // Identity is now always by id; (session, title) is only a non-unique lookup index (see idx_artifact_session_title).
  artifact: `CREATE TABLE IF NOT EXISTS artifact (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL REFERENCES session(id),
    title TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL)`,
  // ON DELETE CASCADE on both FKs: without it, deleting an `artifact` row (there is no delete-artifact path
  // today, but nothing prevents one being added later) would either be blocked by the live FK check once one
  // of these child rows exists, or — for build_file, which references build_job not artifact directly — leave
  // orphaned build_job/build_file rows with no artifact behind them, silently corrupting future `?job` list
  // queries and the join in handleIssues/list_issues. CASCADE keeps a build's row lifecycle tied to its artifact's.
  build_job: `CREATE TABLE IF NOT EXISTS build_job (
    artifact_id INTEGER PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE, session TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    ask TEXT NOT NULL DEFAULT '', manifest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
    created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL)`,
  build_file: `CREATE TABLE IF NOT EXISTS build_file (
    artifact_id INTEGER NOT NULL REFERENCES build_job(artifact_id) ON DELETE CASCADE, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued', lines INTEGER, issues TEXT NOT NULL DEFAULT '[]', error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL, PRIMARY KEY(artifact_id, path))`,
  // issue.artifact_id is nullable by design (a general/session-level item has no artifact) — ON DELETE SET
  // NULL rather than CASCADE, so deleting the artifact a bug was filed against demotes the issue to
  // session-level instead of destroying the backlog entry (and its notes/audit trail) outright.
  issue: `CREATE TABLE IF NOT EXISTS issue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, artifact_id INTEGER REFERENCES artifact(id) ON DELETE SET NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium', source TEXT NOT NULL DEFAULT 'model',
    created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, resolved_ts INTEGER, notes TEXT NOT NULL DEFAULT '[]')`,
};

const INDEXES = [
  // The scheduler's hot query is "what is runnable right now", so it must be an index seek and not a
  // scan of every step ever enqueued — the table is append-heavy and completed rows outnumber ready ones
  // by orders of magnitude within a day.
  `CREATE INDEX IF NOT EXISTS idx_step_ready ON step(status, run_after)`,
  `CREATE INDEX IF NOT EXISTS idx_step_job ON step(job, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_message_session_id ON message(session, id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_ts ON memory(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_fact_accessed ON memory_fact(accessed)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_session_ts ON artifact(session, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_session_title ON artifact(session, title)`,
  `CREATE INDEX IF NOT EXISTS idx_build_job_session_status ON build_job(session, status)`,
  `CREATE INDEX IF NOT EXISTS idx_build_file_artifact ON build_file(artifact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_session_status ON issue(session, status)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_artifact ON issue(artifact_id)`,
];

// One-time migration for an `artifact` table created before this fix, under the old
// `UNIQUE(session, title)` constraint: `CREATE TABLE IF NOT EXISTS` above never touches an
// already-existing table, so the constraint must be dropped explicitly (SQLite has no
// ALTER TABLE ... DROP CONSTRAINT) by rebuilding the table without it. Idempotent: checks the
// live schema text first and is a no-op once migrated (or on a fresh table that never had it).
//
// First cut of this migration failed live with "FOREIGN KEY constraint failed" on the final DROP:
// `ALTER TABLE artifact RENAME TO ...` doesn't just rename — SQLite also silently rewrites every
// OTHER table's stored `REFERENCES artifact(id)` clause to point at the new name, so `artifact_file`
// ends up referencing `artifact_pre_unique_migration` mid-migration. Dropping that table while a live
// FK still points at it is correctly refused. Fix: rebuild `artifact_file` too, in the same pass, so
// nothing references the old name by the time it's dropped — and verify row counts before either
// DROP, so a partial/mismatched copy aborts loudly instead of silently discarding rows.
async function migrateArtifactUniqueConstraint(): Promise<void> {
  try {
    const r = await sqlite.execute({ sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='artifact'`, args: [] });
    const ddl = (r.rows?.[0] as any)?.sql as string | undefined;
    if (!ddl || !/UNIQUE\s*\(\s*session\s*,\s*title\s*\)/i.test(ddl)) return; // not yet created, or already migrated

    const count = async (table: string) => {
      const c = await sqlite.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] });
      return Number((c.rows?.[0] as any)?.n ?? -1);
    };
    const artifactBefore = await count("artifact");
    const filesBefore = await count("artifact_file");

    await sqlite.batch([
      `ALTER TABLE artifact RENAME TO artifact_pre_unique_migration`,
      `CREATE TABLE artifact (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL REFERENCES session(id),
        title TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL)`,
      `INSERT INTO artifact (id, session, title, kind, content, ts)
        SELECT id, session, title, kind, content, ts FROM artifact_pre_unique_migration`,
      // artifact_file's REFERENCES clause was just silently rewritten (by the RENAME above) to point at
      // artifact_pre_unique_migration — rebuild it too, fresh, against the new `artifact` table, before
      // anything tries to drop the old one.
      `ALTER TABLE artifact_file RENAME TO artifact_file_pre_migration`,
      `CREATE TABLE artifact_file (
        artifact_id INTEGER NOT NULL REFERENCES artifact(id), path TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY(artifact_id, path))`,
      `INSERT INTO artifact_file (artifact_id, path, content, ts)
        SELECT artifact_id, path, content, ts FROM artifact_file_pre_migration`,
    ]);

    const artifactAfter = await count("artifact");
    const filesAfter = await count("artifact_file");
    if (artifactAfter !== artifactBefore || filesAfter !== filesBefore) {
      // Leave everything as-is (both old and new tables present) rather than drop anything on a
      // mismatched copy — a human needs to look at this, not have rows silently vanish.
      console.error(`migrateArtifactUniqueConstraint: row-count mismatch after copy (artifact ${artifactBefore}->${artifactAfter}, artifact_file ${filesBefore}->${filesAfter}) — old tables left in place, NOT dropped, migration will retry next startup`);
      return;
    }

    // Nothing references the old table names anymore (artifact_file was rebuilt above) — safe to drop.
    await sqlite.batch([
      `DROP TABLE artifact_file_pre_migration`,
      `DROP TABLE artifact_pre_unique_migration`,
    ]);
  } catch (e) {
    console.error("migrateArtifactUniqueConstraint failed (artifact table left as-is):", e);
  }
}

/** Add a column to an existing table, idempotently.
 *
 *  `CREATE TABLE IF NOT EXISTS` never alters a table that already exists — a caveat this codebase has
 *  already been bitten by once (see migrateArtifactUniqueConstraint above). Adding `gate` to the `step`
 *  DDL therefore does NOTHING on any deployment where `step` was created before that column existed, and
 *  every scheduler query then fails with "no such column: gate" — silently, because db.ts returns
 *  failures as values rather than throwing. SQLite's ALTER TABLE ADD COLUMN is cheap and safe; the guard
 *  reads the live column list so re-running is a no-op.
 *  Returns true when the column was added, false when it already existed or the table does not exist. */
async function addColumnIfMissing(table: string, column: string, decl: string): Promise<boolean> {
  try {
    const info = await sqlite.execute(`PRAGMA table_info(${table})`);
    const rows = (info?.rows ?? []) as unknown[][];
    if (!rows.length) return false; // table not created yet: the CREATE TABLE already includes the column
    const names = rows.map((r) => String(r[1]));
    if (names.includes(column)) return false;
    await sqlite.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    return true;
  } catch (e) {
    console.error(`addColumnIfMissing(${table}.${column}) failed:`, e);
    return false;
  }
}

/** Every column of a CREATE TABLE, as {name, decl}. Table-level constraints (PRIMARY KEY(a,b),
 *  FOREIGN KEY, UNIQUE(...), CHECK) are skipped: they are not columns and cannot be added later anyway. */
export function ddlColumns(ddl: string): { name: string; decl: string }[] {
  const open = ddl.indexOf("(");
  const inner = ddl.slice(open + 1, ddl.lastIndexOf(")"));
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out: { name: string; decl: string }[] = [];
  for (const raw of parts) {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t || /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(t)) continue;
    const m = /^([A-Za-z_][\w$]*)\s+(.*)$/.exec(t);
    if (m) out.push({ name: m[1], decl: m[2] });
  }
  return out;
}

/** A column declaration rewritten so SQLite will accept it in ALTER TABLE ADD COLUMN.
 *
 *  SQLite refuses PRIMARY KEY and UNIQUE in ADD COLUMN outright, requires a non-NULL default for
 *  NOT NULL, and only permits REFERENCES when the default is NULL. A migration that ignores any of
 *  those throws, and the catch in addColumnIfMissing turns the throw into a shrug — so the rewrite
 *  happens here, deliberately and visibly, rather than being discovered as a silent no-op. */
export function alterableDecl(decl: string): string | null {
  let d = decl.replace(/\bPRIMARY\s+KEY\b/gi, "").replace(/\bAUTOINCREMENT\b/gi, "").replace(/\bUNIQUE\b/gi, "").replace(/\s+/g, " ").trim();
  if (!d) return null;
  const notNull = /\bNOT\s+NULL\b/i.test(d);
  const hasDefault = /\bDEFAULT\b/i.test(d);
  if (notNull && !hasDefault) {
    const type = (/^(\w+)/.exec(d)?.[1] ?? "TEXT").toUpperCase();
    const zero = type.includes("INT") || type.includes("REAL") || type.includes("NUM") ? "0" : "''";
    d += ` DEFAULT ${zero}`;
  }
  // A foreign key can only be added with a NULL default, and anything reaching here has a default or is
  // nullable-but-referencing; dropping the clause keeps the column (the data) rather than the constraint.
  if (/\bREFERENCES\b/i.test(d)) d = d.replace(/\bREFERENCES\b[\s\S]*$/i, "").trim();
  return d || null;
}

/** BRING EVERY EXISTING TABLE UP TO ITS CURRENT DDL.
 *
 *  `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so every column added to a
 *  DDL after a deployment is missing on that deployment FOREVER, and every query touching it fails with
 *  "no such column" — silently, because this module returns failures as values instead of throwing.
 *
 *  The previous answer was one hand-written line per column, and exactly one existed (step.gate) against
 *  a schema that has gained many since. Remembering to add a line is not a mechanism. This derives the
 *  migration from the DDL that is already the source of truth, so a column cannot be added to the schema
 *  without also being added to every live database. Returns what it changed, for the caller to log. */
export async function syncSchema(ddl: Record<string, string> = DDL): Promise<string[]> {
  const added: string[] = [];
  // ONE round trip for the WHOLE schema.
  //
  // The previous version asked `PRAGMA table_info(<table>)` once per TABLE — twenty sequential network
  // round trips on every cold isolate, inside initDB, which every request calls. (The version before
  // THAT asked once per COLUMN, about eighty, and took the val down.) sqlite_master already holds every
  // table's CREATE statement, so the live column set can be parsed from the same `ddlColumns` function
  // that parses the DDL being migrated TO — one query, one parse, no per-table chatter. The ALTERs
  // themselves still cost a round trip each, but those only happen on the deploy that introduces a
  // column, not on every cold start forever.
  let liveTables: Map<string, Set<string>>;
  try {
    const r = await sqlite.execute(`SELECT name, sql FROM sqlite_master WHERE type='table'`);
    liveTables = new Map(((r?.rows ?? []) as any[]).map((row) => {
      const name = String(row.name ?? row[0] ?? "");
      const createSql = String(row.sql ?? row[1] ?? "");
      return [name, new Set(createSql ? ddlColumns(createSql).map((c) => c.name) : [])] as const;
    }));
  } catch (e) {
    console.error("[db] schema sync could not read sqlite_master (skipping migration):", e);
    return added;
  }
  for (const [table, create] of Object.entries(ddl)) {
    const have = liveTables.get(table);
    if (!have || have.size === 0) continue; // table absent: CREATE TABLE already declared every column
    for (const col of ddlColumns(create)) {
      if (have.has(col.name)) continue;
      const decl = alterableDecl(col.decl);
      if (!decl) continue;
      try {
        await sqlite.execute(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${decl}`);
        added.push(`${table}.${col.name}`);
      } catch (e) {
        // A migration that cannot run must not take the application down. The column stays missing and
        // the queries needing it fail on their own terms, which beats every route answering 500.
        console.error(`[db] schema sync for ${table}.${col.name} failed (continuing):`, e);
      }
    }
  }
  return added;
}

let initOnce: Promise<Result<void, DbError>> | null = null;

/** Create/patch the schema. Called at the top of EVERY request by both entrypoints, so it memoises:
 *  the DDL batch, the migrations and the index batch are idempotent but they are not free, and paying
 *  for them on every request is how a correct migration became an outage. A failed init is not cached —
 *  the next request retries it. */
const initDB = (): Promise<Result<void, DbError>> => {
  if (initOnce) return initOnce;
  initOnce = attempt(async () => {
    await sqlite.batch([`PRAGMA foreign_keys = ON`, ...Object.values(DDL)]);
    await migrateArtifactUniqueConstraint(); // must run after CREATE TABLE IF NOT EXISTS (needs the table to exist) and before the new index below
    const added = await syncSchema();
    if (added.length) console.log("[db] schema sync added:", added.join(", "));
    await sqlite.batch(INDEXES);
  }, "initDB (DDL batch + migrations + indexes)").then((r) => {
    if (!r.ok) initOnce = null; // a failed init must be retried, not remembered
    return r;
  });
  return initOnce;
};

/* ────────────────────────────────────────────────────────────────
   Query core — one primitive, three call shapes.

   `sql` is a tagged template: values are never concatenated into
   the statement text, so injection is structurally impossible, not
   just discouraged by convention.

   The `Table` argument to `all`/`one` is a phantom: zero runtime
   cost, exists purely to pin the generic so the return type is
   declared honestly by the caller instead of inferred from SQL
   text (which is what broke in the original — template-literal
   type matching only resolves on string-literal SQL and silently
   collapses to `unknown` for anything built at runtime).
   ──────────────────────────────────────────────────────────────── */
// The exact set of values libsql/SQLite can bind as a parameter (mirrors
// @libsql/client's InValue). `unknown[]` doesn't satisfy either `execute`
// overload — TS falls through to the `(sql: string, args?: InArgs)` form
// and reports the whole `{sql, args}` object as an invalid `sql` argument,
// which is a confusing symptom of an unrelated cause. Declaring the real
// value type here fixes it at the source instead of casting at each call.
type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | ArrayBuffer
  | Uint8Array
  | Date
  | null;
type Bound = { text: string; values: SqlValue[] };
const sql = (strings: TemplateStringsArray, ...values: SqlValue[]): Bound => ({
  text: strings.reduce(
    (acc, s, i) => acc + s + (i < values.length ? "?" : ""),
    "",
  ),
  values,
});

// sqlite.execute returns libsql's ResultSet, whose .rows are libsql's own
// Row type — every column typed as `Value = null | string | number | bigint
// | ArrayBuffer`, regardless of what our schema declares. TS correctly
// refuses a direct cast to Row<T> here: nothing in the type system knows a
// TEXT NOT NULL column can't come back null, or that an INTEGER won't come
// back as bigint. That guarantee lives in the SQL schema, not in types, so
// this is an explicit, acknowledged boundary crossing — not a verified one.
function all<T extends Table>(_table: T, q: Bound) {
  return attempt(
    async () =>
      (await sqlite.execute({ sql: q.text, args: q.values }))
        .rows as unknown as Row<T>[],
    q.text,
  );
}

async function one<T extends Table>(table: T, q: Bound) {
  const r = await all(table, q);
  return r.ok ? Ok(r.value[0] ?? null) : r;
}

// Escape hatch for shapes that don't correspond to any single table — an
// aggregate like `SELECT COUNT(*) AS c`, a join projection, etc. `all`/`one`
// can't type these honestly because their phantom `Table` argument has
// nothing to pin to. Here the caller declares the shape directly via the
// explicit generic — same honesty contract as `all`, just without a table
// to anchor it to.
function raw<T>(q: Bound) {
  return attempt(async () =>
    (await sqlite.execute({ sql: q.text, args: q.values }))
      .rows as unknown as T[]
  , q.text);
}

// unwrap(r) → value | null; unwrap(r, fallback) → value | fallback. The old signature
// dropped the fallback, so every `unwrap(x, [])` caller got null on a DB error and
// then crashed on `.map` — a latent bug the types were hiding.
function unwrap<T>(r: Result<T, DbError>): T | null;
function unwrap<T>(r: Result<T, DbError>, fallback: T): T;
function unwrap<T>(r: Result<T, DbError>, fallback?: T): T | null {
  return r.ok ? r.value : (fallback === undefined ? null : fallback);
}

// libsql's ResultSet carries rowsAffected and lastInsertRowid — the only
// way to learn the AUTOINCREMENT id of a row just inserted, or to confirm
// a write actually touched anything. Discarding it (`.then(() => undefined)`)
// made insertMessage() write rows whose id was permanently unrecoverable.
type Effect = { rowsAffected: number; lastInsertRowid: bigint | undefined };
const run = (q: Bound) =>
  attempt(async () => {
    const r = await sqlite.execute({ sql: q.text, args: q.values });
    return {
      rowsAffected: r.rowsAffected,
      lastInsertRowid: r.lastInsertRowid,
    } satisfies Effect;
  }, q.text);

/* ────────────────────────────────────────────────────────────────
   Domain operations — thin pipelines over the three primitives.
   Retention is not an afterthought: every write can fail on quota,
   and the failure is handled as data, not caught upstream by luck.
   ──────────────────────────────────────────────────────────────── */
const messagesFor = (session: string, limit = 200) =>
  all(
    "message",
    sql`SELECT * FROM message WHERE session = ${session} ORDER BY id DESC LIMIT ${limit}`,
  );

const insertMessage = async (m: Omit<Row<"message">, "id">) => {
  const r = await run(
    sql`INSERT INTO message (role, content, ts, session, providerId)
          VALUES (${m.role}, ${m.content}, ${m.ts}, ${m.session}, ${m.providerId})`,
  );
  if (!r.ok) return r;
  // lastInsertRowid is undefined only if this wasn't actually an INSERT into
  // a ROWID table — Number(undefined) would silently produce NaN here, which
  // is worse than failing loudly, since a NaN id would propagate downstream
  // looking like a valid one.
  if (r.value.lastInsertRowid === undefined) return Err<DbError>("UNKNOWN");
  return Ok(Number(r.value.lastInsertRowid));
};

const pruneSession = (session: string, keep = 200) =>
  run(sql`DELETE FROM message WHERE session = ${session} AND id NOT IN
          (SELECT id FROM message WHERE session = ${session} ORDER BY id DESC LIMIT ${keep})`);

// Val Town's real ceiling is the storage quota (10MB free / 1GB paid,
// Turso-backed), not SQLite's own ~2^31-byte string limit. On
// QUOTA_EXCEEDED, prune this session hard and retry once. If the
// retry still fails, the caller gets the real error, not a silent drop.
const insertMessageSafe = async (m: Omit<Row<"message">, "id">) => {
  const first = await insertMessage(m);

  if (first.ok === false) {
    if (first.error === "QUOTA_EXCEEDED") {
      const pruned = await pruneSession(m.session, 100);
      return pruned.ok ? insertMessage(m) : pruned;
    }
  }
  return first;
};

const upsertMemory = (key: string, value: string, weight: number, ts: number) =>
  run(
    sql`INSERT INTO memory (key, value, weight, ts) VALUES (${key}, ${value}, ${weight}, ${ts})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, weight = excluded.weight, ts = excluded.ts`,
  );

const providerById = (id: string) =>
  one("provider", sql`SELECT * FROM provider WHERE id = ${id}`);

const providersByPriority = () =>
  all("provider", sql`SELECT * FROM provider ORDER BY priority ASC`);

const touchSession = (id: string, name: string, ts: number) =>
  run(sql`INSERT INTO session (id, name, ts) VALUES (${id}, ${name}, ${ts})
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, ts = excluded.ts`);

// One row per provider instance name; requests/ok/failed are running totals across every isolate that
// has ever reported for that name, not a per-call snapshot — the UPDATE adds this call's outcome to
// whatever was already there rather than replacing it.
const bumpProviderStats = (name: string, ok: boolean, error: string | null, ts: number) =>
  run(sql`INSERT INTO provider_stats (name, requests, ok, failed, last_error, updated_at)
          VALUES (${name}, 1, ${ok ? 1 : 0}, ${ok ? 0 : 1}, ${error}, ${ts})
          ON CONFLICT(name) DO UPDATE SET
            requests = requests + 1,
            ok = ok + ${ok ? 1 : 0},
            failed = failed + ${ok ? 0 : 1},
            last_error = COALESCE(${error}, provider_stats.last_error),
            updated_at = ${ts}`);

const providerStatsAll = () => all("provider_stats", sql`SELECT * FROM provider_stats`);

export {
  all,
  type Bound,
  bumpProviderStats,
  type DbError,
  Err,
  initDB,
  insertMessage,
  insertMessageSafe,
  messagesFor,
  Ok,
  one,
  providerById,
  providersByPriority,
  providerStatsAll,
  pruneSession,
  raw,
  type Result,
  type Row,
  run,
  type Schema,
  sql,
  type Table,
  touchSession,
  unwrap,
  upsertMemory,
};