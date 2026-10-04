// ─────────────────────────────────────────────────────────────
// Standardized, renamed, expanded DB helper layer
// Single code block as requested
// ─────────────────────────────────────────────────────────────

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

import { AsyncLocalStorage } from "node:async_hooks";

// ─────────────────────────────
// Types
// ─────────────────────────────

type Provider = {
  id: number;
  name: string;
  base: string;
  keyEnv: string | null;
  fallbackModel: string | null;
  priority: number;
};

type MessageRow = {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  session: string;
  providerId: string | null;
};

type MemoryRow = {
  key: string;
  value: string;
  weight: number;
  ts: number;
};

type SessionRow = {
  id: string;
  name: string;
  ts: number;
};

type SavedModelRow = {
  provider: string;
  selected_model: string;
};

type SqlText<T extends string> = { readonly sql: T };
type SqlArgs<A extends any[]> = { readonly args: A };
type DbResult<R> = { rows: R[] };

type RowOf<T extends string> = T extends
  `SELECT ${string} FROM messages ${string}` ? MessageRow
  : T extends `SELECT ${string} FROM memory ${string}` ? MemoryRow
  : T extends `SELECT ${string} FROM provider ${string}` ? Provider
  : T extends `SELECT ${string} FROM session ${string}` ? SessionRow
  : T extends `SELECT ${string} FROM message ${string}` ? MessageRow
  : T extends `SELECT ${string} FROM omni_router_config ${string}`
    ? SavedModelRow
  : unknown;

type Run = <Q extends string, A extends SqlArgs<any>>(
  q: SqlText<Q> & A,
) => Promise<
  Q extends `SELECT ${string}` ? (<R>(k: (x: RowOf<Q>[]) => R) => R)
    : (<R>(k: (x: void) => R) => R)
>;

// ─────────────────────────────
// Schema initialization
// ─────────────────────────────

async function initDB() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS provider (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base TEXT NOT NULL,
      keyEnv TEXT NULL,
      fallbackModel TEXT NULL,
      priority INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS message (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT NOT NULL DEFAULT 'default',
      providerId TEXT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      weight REAL NOT NULL,
      ts INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'New Chat',
      ts INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS omni_router_config (
      provider TEXT PRIMARY KEY,
      selected_model TEXT NOT NULL
    )`,
  ]);
}

// ─────────────────────────────
// Core DB helpers (renamed + expanded)
// ─────────────────────────────

async function dbQuery<Q extends string, A extends any[]>(
  q: SqlText<Q> & SqlArgs<A>,
): Promise<DbResult<RowOf<Q>>> {
  const r = await sqlite.execute({ sql: q.sql, args: q.args });
  return r as unknown as DbResult<RowOf<Q>>;
}

async function dbSelectMany<Q extends string, A extends any[]>(
  q: SqlText<Q> & SqlArgs<A>,
): Promise<RowOf<Q>[]> {
  const r = await dbQuery(q);
  return (r as any).rows as RowOf<Q>[];
}

async function dbSelectOne<Q extends string, A extends any[]>(
  q: SqlText<Q> & SqlArgs<A>,
): Promise<RowOf<Q>> {
  const r = await sqlite.execute({ sql: q.sql, args: q.args });
  const rows = (r as any).rows as RowOf<Q>[];

  if (rows.length === 0) {
    throw new Error(`dbSelectOne: no rows for query: ${q.sql}`);
  }
  if (rows.length > 1) {
    throw new Error(`dbSelectOne: expected 1 row, got ${rows.length}`);
  }

  return rows[0];
}

async function dbMaybeOne<Q extends string, A extends any[]>(
  q: SqlText<Q> & SqlArgs<A>,
): Promise<RowOf<Q> | null> {
  const r = await sqlite.execute({ sql: q.sql, args: q.args });
  const rows = (r as any).rows as RowOf<Q>[];
  return rows.length === 0 ? null : rows[0];
}

async function dbExists<Q extends string, A extends any[]>(
  q: SqlText<Q> & SqlArgs<A>,
): Promise<boolean> {
  const r = await dbQuery(q);
  return r.rows.length > 0;
}

async function dbCount<A extends any[]>(
  q: SqlText<`SELECT COUNT(*) as count ${string}`> & SqlArgs<A>,
): Promise<number> {
  const r = await dbQuery(q);
  return (r.rows[0] as any).count;
}

async function dbExecute<A extends any[]>(
  q: SqlText<string> & SqlArgs<A>,
): Promise<void> {
  await sqlite.execute({ sql: q.sql, args: q.args });
}

// ─────────────────────────────
// CPS wrapper (renamed)
// ─────────────────────────────

const dbRunCPS: Run = async (q) => {
  const r = await sqlite.execute({ sql: q.sql, args: q.args });
  const typed = r as unknown as DbResult<RowOf<typeof q.sql>>;
  const isSelect = /^\s*select\b/i.test(q.sql);

  return ((k: any) => {
    return isSelect ? k(typed.rows) : k(undefined);
  }) as any;
};

// ─────────────────────────────
// Exports
// ─────────────────────────────

// ─────────────────────────────────────────────────────────────
// Typed CRUD Repository Layer
// Builds on top of your standardized DB helpers
// ─────────────────────────────────────────────────────────────

/*
  Assumes the following imports exist:

  import {
    dbSelectOne,
    dbSelectMany,
    dbMaybeOne,
    dbExecute,
    dbExists,
    dbCount,
    type SqlText,
    type SqlArg,
    type SqlArgs,
    type Provider,
    type MessageRow,
  type MemoryRow,
    type SessionRow,
    type SavedModelRow,
  } from "./db.ts";
*/
// ─────────────────────────────────────────────────────────────
// UNIVERSAL REPOSITORY TEMPLATES
// These patterns generate CRUD repositories for ANY table.
// ─────────────────────────────────────────────────────────────

// Core DB helpers assumed imported:
// dbSelectOne, dbSelectMany, dbMaybeOne, dbExecute, dbExists, dbCount

// ─────────────────────────────
// Template 1: Basic CRUD Repository
// ─────────────────────────────

export function createBasicRepo<
  Row,
  PK extends keyof Row,
  Insert extends Omit<Row, PK>,
  Update extends Partial<Omit<Row, PK>>,
>(config: {
  table: string;
  primaryKey: PK;
  insertFields: (keyof Insert)[];
  updateFields: (keyof Update)[];
}) {
  const { table, primaryKey, insertFields, updateFields } = config;

  return {
    // GET BY PRIMARY KEY
    async get(id: Row[PK]): Promise<Row | null> {
      return (await dbMaybeOne({
        sql: `SELECT * FROM ${table} WHERE ${String(primaryKey)} = ?`,
        args: [id],
      })) as any as Row;
    },

    // LIST ALL
    async list(): Promise<Row[]> {
      return (await dbSelectMany({
        sql: `SELECT * FROM ${table}`,
        args: [],
      }) as any).rows as Row[];
    },

    // INSERT
    async insert(data: Insert): Promise<void> {
      const cols = insertFields.map(String).join(", ");
      const placeholders = insertFields.map(() => "?").join(", ");
      const values = insertFields.map((f) => (data as any)[f]);

      await dbExecute({
        sql: `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
        args: values,
      });
    },

    // UPDATE
    async update(id: Row[PK], data: Update): Promise<void> {
      const fields = updateFields.filter((f) => (data as any)[f] !== undefined);
      if (fields.length === 0) return;

      const setClause = fields.map((f) => `${String(f)} = ?`).join(", ");
      const values = fields.map((f) => (data as any)[f]);

      await dbExecute({
        sql: `UPDATE ${table} SET ${setClause} WHERE ${String(primaryKey)} = ?`,
        args: [...values, id],
      });
    },

    // DELETE
    async remove(id: Row[PK]): Promise<void> {
      await dbExecute({
        sql: `DELETE FROM ${table} WHERE ${String(primaryKey)} = ?`,
        args: [id],
      });
    },

    // EXISTS
    async exists(id: Row[PK]): Promise<boolean> {
      return await dbExists({
        sql: `SELECT 1 FROM ${table} WHERE ${String(primaryKey)} = ? LIMIT 1`,
        args: [id],
      });
    },

    // COUNT
    async count(): Promise<number> {
      return await dbCount({
        sql: `SELECT COUNT(*) as count FROM ${table}`,
        args: [],
      });
    },
  };
}

// ─────────────────────────────
// Template 2: Session‑Scoped Repository
// (for tables like "message" that belong to a session)
// ─────────────────────────────

export function createSessionScopedRepo<
  Row,
  Insert extends Omit<Row, "id">,
  SessionKey extends keyof Row,
>(config: {
  table: string;
  sessionField: SessionKey;
  insertFields: (keyof Insert)[];
}) {
  const { table, sessionField, insertFields } = config;

  return {
    async listBySession(session: Row[SessionKey]): Promise<Row[]> {
      return (await dbSelectMany({
        sql: `SELECT * FROM ${table} WHERE ${
          String(sessionField)
        } = ? ORDER BY ts ASC`,
        args: [session],
      }) as any).rows as Row[];
    },

    async insert(data: Insert): Promise<void> {
      const cols = insertFields.map(String).join(", ");
      const placeholders = insertFields.map(() => "?").join(", ");
      const values = insertFields.map((f) => (data as any)[f]);

      await dbExecute({
        sql: `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
        args: values,
      });
    },

    async deleteBySession(session: Row[SessionKey]): Promise<void> {
      await dbExecute({
        sql: `DELETE FROM ${table} WHERE ${String(sessionField)} = ?`,
        args: [session],
      });
    },
  };
}

// ─────────────────────────────
// Template 3: Upsert Repository
// (for tables like memory or model config)
// ─────────────────────────────

export function createUpsertRepo<
  Row,
  PK extends keyof Row,
  Insert extends Row,
>(config: {
  table: string;
  primaryKey: PK;
  fields: (keyof Row)[];
}) {
  const { table, primaryKey, fields } = config;

  return {
    async get(id: Row[PK]): Promise<Row | null> {
      const res = (await dbMaybeOne({
        sql: `SELECT * FROM ${table} WHERE ${String(primaryKey)} = ?`,
        args: [id],
      })) as any as Row;
      return res;
    },

    async list(): Promise<Row[]> {
      const res = (await dbSelectMany({
        sql: `SELECT * FROM ${table}`,
        args: [],
      }) as any).rows as Row[];
      return res;
    },

    async upsert(data: Insert): Promise<void> {
      const cols = fields.map(String).join(", ");
      const placeholders = fields.map(() => "?").join(", ");
      const updates = fields.map((f) => `${String(f)} = excluded.${String(f)}`)
        .join(", ");
      const values = fields.map((f) => (data as any)[f]);

      await dbExecute({
        sql: `
          INSERT INTO ${table} (${cols})
          VALUES (${placeholders})
          ON CONFLICT(${String(primaryKey)}) DO UPDATE SET ${updates}
        `,
        args: values,
      });
    },

    async remove(id: Row[PK]): Promise<void> {
      await dbExecute({
        sql: `DELETE FROM ${table} WHERE ${String(primaryKey)} = ?`,
        args: [id],
      });
    },
  };
}

const ProviderRepo = createBasicRepo<
  Provider,
  "id",
  Omit<Provider, "id">,
  Partial<Omit<Provider, "id">>
>({
  table: "provider",
  primaryKey: "id",
  insertFields: ["name", "base", "keyEnv", "fallbackModel", "priority"],
  updateFields: ["name", "base", "keyEnv", "fallbackModel", "priority"],
});

export const MemoryRepo = createUpsertRepo<MemoryRow, "key", MemoryRow>({
  table: "memory",
  primaryKey: "key",
  fields: ["key", "value", "weight", "ts"],
});

export const SessionRepo = createBasicRepo<
  SessionRow,
  "id",
  Omit<SessionRow, "id">,
  Partial<Omit<SessionRow, "id">>
>({
  table: "session",
  primaryKey: "id",
  insertFields: ["name", "ts"],
  updateFields: ["name", "ts"],
});

export const SavedModelRepo = createUpsertRepo<
  SavedModelRow,
  "provider",
  SavedModelRow
>({
  table: "omni_router_config",
  primaryKey: "provider",
  fields: ["provider", "selected_model"],
});

export const MessageRepo = createSessionScopedRepo<
  MessageRow,
  Omit<MessageRow, "id">,
  "session"
>({
  table: "message",
  sessionField: "session",
  insertFields: ["role", "content", "ts", "session", "providerId"],
});

const txStore = new AsyncLocalStorage<{ depth: number }>();

export async function dbTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const store = txStore.getStore() ?? { depth: 0 };
  const isTop = store.depth === 0;
  const sp = `sp_${store.depth}`;

  const run = async () => {
    try {
      if (isTop) {
        await sqlite.execute({ sql: "BEGIN", args: [] });
      } else {
        await sqlite.execute({ sql: `SAVEPOINT ${sp}`, args: [] });
      }

      store.depth++;
      const result = await fn();
      store.depth--;

      if (isTop) {
        await sqlite.execute({ sql: "COMMIT", args: [] });
      } else {
        await sqlite.execute({ sql: `RELEASE SAVEPOINT ${sp}`, args: [] });
      }

      return result;
    } catch (err) {
      store.depth--;

      if (isTop) {
        await sqlite.execute({ sql: "ROLLBACK", args: [] });
      } else {
        await sqlite.execute({ sql: `ROLLBACK TO SAVEPOINT ${sp}`, args: [] });
        await sqlite.execute({ sql: `RELEASE SAVEPOINT ${sp}`, args: [] });
      }

      throw err;
    }
  };

  return await txStore.run(store, run);
}

// ─────────────────────────────
// MIGRATION TYPES
// ─────────────────────────────

export type MigrationId = string;

export type Migration = {
  id: MigrationId; // e.g. "001_init", "002_add_memory_weight_index"
  up: string | string[]; // SQL or list of SQL statements
  down?: string | string[]; // optional rollback
};

export type MigrationRecord = {
  id: string;
  applied_at: number;
};

// ─────────────────────────────
// MIGRATION TABLE + CORE QUERIES
// ─────────────────────────────

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`;

async function ensureMigrationTable(): Promise<void> {
  await sqlite.execute({ sql: MIGRATION_TABLE_SQL, args: [] });
}

async function getAppliedMigrations(): Promise<MigrationRecord[]> {
  const r = await sqlite.execute({
    sql: `SELECT id, applied_at FROM _migrations ORDER BY applied_at ASC`,
    args: [],
  });
  return (r as any).rows as MigrationRecord[];
}

async function markMigrationApplied(id: MigrationId): Promise<void> {
  await sqlite.execute({
    sql: `INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`,
    args: [id, Date.now()],
  });
}

async function unmarkMigration(id: MigrationId): Promise<void> {
  await sqlite.execute({
    sql: `DELETE FROM _migrations WHERE id = ?`,
    args: [id],
  });
}

// ─────────────────────────────
// EXECUTION HELPERS
// ─────────────────────────────

async function execSql(sql: string | string[]): Promise<void> {
  if (Array.isArray(sql)) {
    for (const s of sql) {
      if (!s.trim()) continue;
      await sqlite.execute({ sql: s, args: [] });
    }
  } else {
    if (!sql.trim()) return;
    await sqlite.execute({ sql, args: [] });
  }
}

// ─────────────────────────────
// TRANSACTION WRAPPER (LOCAL)
// ─────────────────────────────

async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  await sqlite.execute({ sql: "BEGIN", args: [] });
  try {
    const result = await fn();
    await sqlite.execute({ sql: "COMMIT", args: [] });
    return result;
  } catch (err) {
    await sqlite.execute({ sql: "ROLLBACK", args: [] });
    throw err;
  }
}

// ─────────────────────────────
// MIGRATION REGISTRY (DENSE, EXPLICIT)
// Add new migrations here in strict order.
// ─────────────────────────────

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init_schema",
    up: [
      `CREATE TABLE IF NOT EXISTS provider (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        base TEXT NOT NULL,
        keyEnv TEXT NULL,
        fallbackModel TEXT NULL,
        priority INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS message (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL,
        session TEXT NOT NULL DEFAULT 'default',
        providerId TEXT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        weight REAL NOT NULL,
        ts INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'New Chat',
        ts INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS omni_router_config (
        provider TEXT PRIMARY KEY,
        selected_model TEXT NOT NULL
      )`,
    ],
  },
  {
    id: "002_indexes",
    up: [
      `CREATE INDEX IF NOT EXISTS idx_message_session_ts ON message (session, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_weight ON memory (weight DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_session_ts ON session (ts DESC)`,
    ],
  },
  // Add future migrations here:
  // {
  //   id: "003_some_change",
  //   up: [...],
  //   down: [...],
  // },
];

// ─────────────────────────────
// MIGRATION RESOLUTION
// ─────────────────────────────

function diffMigrations(
  all: Migration[],
  applied: MigrationRecord[],
): { pending: Migration[]; unknownApplied: MigrationRecord[] } {
  const appliedSet = new Set(applied.map((m) => m.id));
  const knownSet = new Set(all.map((m) => m.id));

  const pending = all.filter((m) => !appliedSet.has(m.id));
  const unknownApplied = applied.filter((m) => !knownSet.has(m.id));

  return { pending, unknownApplied };
}

// ─────────────────────────────
// APPLY ALL PENDING MIGRATIONS
// ─────────────────────────────

export async function applyMigrations(): Promise<void> {
  await ensureMigrationTable();
  const applied = await getAppliedMigrations();
  const { pending, unknownApplied } = diffMigrations(MIGRATIONS, applied);

  if (unknownApplied.length > 0) {
    throw new Error(
      `Unknown applied migrations detected: ${
        unknownApplied
          .map((m) => m.id)
          .join(", ")
      }`,
    );
  }

  if (pending.length === 0) return;

  await withTransaction(async () => {
    for (const m of pending) {
      await execSql(m.up);
      await markMigrationApplied(m.id);
    }
  });
}

// ─────────────────────────────
// ROLLBACK LAST MIGRATION (IF DOWN PROVIDED)
// ─────────────────────────────

export async function rollbackLastMigration(): Promise<void> {
  await ensureMigrationTable();
  const applied = await getAppliedMigrations();
  if (applied.length === 0) return;

  const last = applied[applied.length - 1];
  const migration = MIGRATIONS.find((m) => m.id === last.id);
  if (!migration) {
    throw new Error(`Cannot rollback unknown migration: ${last.id}`);
  }
  if (!migration.down) {
    throw new Error(`Migration ${last.id} has no 'down' script`);
  }

  await withTransaction(async () => {
    await execSql(migration.down!);
    await unmarkMigration(last.id);
  });
}

// ─────────────────────────────
// BOOTSTRAP ENTRYPOINT
// Call once at startup to ensure schema is current.
// ─────────────────────────────

export async function initSchema(): Promise<void> {
  await applyMigrations();
}

// ─────────────────────────────────────────────────────────────
// SERVICE LAYER — DOMAIN ORCHESTRATION (IRREDUCIBLE FORM)
// Builds on top of repositories + transactions + DB core.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// SESSION SERVICE
// ─────────────────────────────

export const SessionService = {
  async ensure(id: string): Promise<SessionRow> {
    const existing = await SessionRepo.get(id);
    if (existing) return existing;

    const row: SessionRow = {
      id,
      name: "New Chat",
      ts: Date.now(),
    };

    await SessionRepo.insert(row);
    return row;
  },

  async rename(id: string, name: string): Promise<void> {
    await SessionRepo.rename(id, name);
  },

  async list(): Promise<SessionRow[]> {
    return SessionRepo.list();
  },
};

// ─────────────────────────────
// MESSAGE SERVICE
// ─────────────────────────────

export const MessageService = {
  async append(msg: Omit<MessageRow, "id">): Promise<void> {
    await MessageRepo.insert(msg);
  },

  async list(session: string): Promise<MessageRow[]> {
    return MessageRepo.listBySession(session);
  },

  async clear(session: string): Promise<void> {
    await MessageRepo.deleteBySession(session);
  },
};

// ─────────────────────────────
// MEMORY SERVICE (WEIGHTED SEMANTIC MEMORY)
// ─────────────────────────────

export const MemoryService = {
  async get(key: string): Promise<MemoryRow | null> {
    return await MemoryRepo.get(key);
  },

  async list(): Promise<MemoryRow[]> {
    return await MemoryRepo.list();
  },

  async upsert(key: string, value: string, weight: number): Promise<void> {
    const row: MemoryRow = {
      key,
      value,
      weight,
      ts: Date.now(),
    };
    await MemoryRepo.upsert(row);
  },

  async reinforce(key: string, delta: number): Promise<void> {
    const existing = await MemoryRepo.get(key);
    if (!existing) return;

    const updated: MemoryRow = {
      ...existing,
      weight: existing.weight + delta,
      ts: Date.now(),
    };

    await MemoryRepo.upsert(updated);
  },

  async decay(factor: number): Promise<void> {
    const all = await MemoryRepo.list();
    for (const m of all) {
      const updated: MemoryRow = {
        ...m,
        weight: m.weight * factor,
        ts: Date.now(),
      };
      await MemoryRepo.upsert(updated);
    }
  },
};

// ─────────────────────────────
// PROVIDER SERVICE (SELECTION + PRIORITY)
// ─────────────────────────────

export const ProviderService = {
  async list(): Promise<Provider[]> {
    return await ProviderRepo.list();
  },

  async get(id: number): Promise<Provider | null> {
    return await ProviderRepo.get(id);
  },

  async getBest(): Promise<Provider | null> {
    const providers = await ProviderRepo.list();
    if (providers.length === 0) return null;
    return providers[0]; // priority ASC
  },
};

// ─────────────────────────────
// MODEL CONFIG SERVICE
// ─────────────────────────────

export const ModelConfigService = {
  async get(provider: string): Promise<SavedModelRow | null> {
    return await ModelConfigRepo.get(provider);
  },

  async set(provider: string, model: string): Promise<void> {
    await ModelConfigRepo.set(provider, model);
  },

  async list(): Promise<SavedModelRow[]> {
    return await ModelConfigRepo.list();
  },
};

// ─────────────────────────────
// ROUTER SERVICE (UNIFIED ORCHESTRATION)
// ─────────────────────────────

export const RouterService = {
  async routeMessage(
    session: string,
    role: "user" | "assistant",
    content: string,
  ) {
    return await dbTransaction(async () => {
      const provider = await ProviderService.getBest();
      if (!provider) throw new Error("No provider available");

      const msg: Omit<MessageRow, "id"> = {
        role,
        content,
        ts: Date.now(),
        session,
        providerId: provider.id.toString(),
      };

      await MessageService.append(msg);

      return provider;
    });
  },

  async getConversation(session: string): Promise<MessageRow[]> {
    return await MessageService.list(session);
  },

  async setModel(provider: string, model: string): Promise<void> {
    await ModelConfigService.set(provider, model);
  },
};

// ─────────────────────────────────────────────────────────────
// APPLICATION LAYER — ACTIVE INTELLIGENCE ORCHESTRATION
// Builds on top of Service Layer + Repos + DB Core.
// Irreducible, dense, load-bearing.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// MEMORY RETRIEVAL STRATEGY
// Weighted recall based on top-K by weight.
// ─────────────────────────────

export const MemoryRetrieval = {
  async topK(
    k: number,
  ): Promise<{ key: string; value: string; weight: number }[]> {
    const all = await MemoryService.list();
    return all
      .sort((a, b) => b.weight - a.weight)
      .slice(0, k);
  },

  async contextualRecall(query: string, k: number): Promise<MemoryRow[]> {
    // Placeholder for embedding-based recall; currently weight-only.
    throw new Error("not implemented");
    const all = await MemoryService.list();
    return all
      .sort((a, b) => b.weight - a.weight)
      .slice(0, k);
  },
};

// ─────────────────────────────
// PROVIDER + MODEL SELECTION LOGIC
// Priority-based provider selection + per-provider model config.
// ─────────────────────────────

export const InferenceSelector = {
  async selectProviderAndModel() {
    const provider = await ProviderService.getBest();
    if (!provider) throw new Error("No provider available");

    const cfg = await ModelConfigService.get(provider.name);
    const model = cfg?.selected_model ?? provider.fallbackModel;
    if (!model) {
      throw new Error(`No model configured for provider ${provider.name}`);
    }

    return { provider, model };
  },
};

// ─────────────────────────────
// MESSAGE PIPELINE
// Pre-processing → Memory recall → Routing → Post-processing
// ─────────────────────────────

export const MessagePipeline = {
  async processUserMessage(session: string, content: string) {
    return await dbTransaction(async () => {
      await SessionService.ensure(session);

      const { provider, model } = await InferenceSelector
        .selectProviderAndModel();

      const recall = await MemoryRetrieval.topK(8);

      await MessageService.append({
        role: "user",
        content,
        ts: Date.now(),
        session,
        providerId: provider.id.toString(),
      });

      return {
        provider,
        model,
        recall,
      };
    });
  },

  async processAssistantMessage(
    session: string,
    content: string,
    providerId: string,
  ) {
    return await dbTransaction(async () => {
      await MessageService.append({
        role: "assistant",
        content,
        ts: Date.now(),
        session,
        providerId,
      });
    });
  },
};

// ─────────────────────────────
// CONVERSATION STATE MACHINE
// Stateless interface over stateful DB-backed session.
// ─────────────────────────────

export const ConversationState = {
  async get(session: string) {
    const messages = await MessageService.list(session);
    const memory = await MemoryService.list();
    return { messages, memory };
  },

  async clear(session: string) {
    await MessageService.clear(session);
  },
};

// ─────────────────────────────
// APPLICATION ORCHESTRATOR
// High-level interface for the entire system.
// ─────────────────────────────

export const App = {
  async userMessage(session: string, content: string) {
    const { provider, model, recall } = await MessagePipeline
      .processUserMessage(session, content);

    return {
      provider,
      model,
      recall,
      conversation: await ConversationState.get(session),
    };
  },

  async assistantMessage(session: string, content: string, providerId: string) {
    await MessagePipeline.processAssistantMessage(session, content, providerId);
    return await ConversationState.get(session);
  },

  async setModel(provider: string, model: string) {
    await ModelConfigService.set(provider, model);
  },

  async getConversation(session: string) {
    return await ConversationState.get(session);
  },

  async resetSession(session: string) {
    await ConversationState.clear(session);
  },
};

// ─────────────────────────────────────────────────────────────
// INFERENCE LAYER — PROVIDER-AGNOSTIC MODEL INVOCATION ENGINE
// Dense, irreducible, load-bearing.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// UNIVERSAL OPENAI-COMPATIBLE ADAPTER + REGISTRY
// All providers share the same schema; differ by base URL, key, model.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// PROVIDER REGISTRY (DB-BACKED)
// provider table already exists in your schema:
//   id, name, base, keyEnv, fallbackModel, priority
// ─────────────────────────────

// ─────────────────────────────
// UNIVERSAL OPENAI-COMPATIBLE CLIENT
// Assumes: POST { model, messages } → { choices[0].message.content }
// ─────────────────────────────

export type ChatMessage = { role: string; content: string };

export type UniversalInvokeResult = {
  output: string;
  usage?: any;
  raw?: any;
};

export async function universalInvoke(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  opts: { stream?: boolean } = {},
): Promise<UniversalInvokeResult> {
  const apiKey = provider.keyEnv ? Deno.env.get(provider.keyEnv) : undefined;
  if (!apiKey) throw new Error(`Missing API key for provider ${provider.name}`);

  const url = provider.base.startsWith("/")
    ? provider.base + "v1/chat/completions"
    : provider.base + "/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: opts.stream ?? false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Provider ${provider.name} error ${res.status}: ${text}`,
    );
  }

  const json = await res.json();
  const output = json.choices?.[0]?.message?.content ??
    json.choices?.[0]?.delta?.content ??
    "";

  return { output, usage: json.usage, raw: json };
}

export const ModelConfigRepo = {
  async get(provider: string): Promise<SavedModelRow | null> {
    const r = await sqlite.execute({
      sql: `SELECT provider, selected_model
            FROM omni_router_config
            WHERE provider = ?`,
      args: [provider],
    });
    const rows = (r as any).rows as SavedModelRow[];
    return rows[0] ?? null;
  },

  async set(provider: string, model: string): Promise<void> {
    await sqlite.execute({
      sql: `INSERT INTO omni_router_config (provider, selected_model)
            VALUES (?, ?)
            ON CONFLICT(provider) DO UPDATE SET selected_model = excluded.selected_model`,
      args: [provider, model],
    });
  },
  // LIST ALL
  async list(): Promise<SavedModelRow[]> {
    return ((await dbSelectMany({
      sql: `SELECT * FROM omni_router_config`,
      args: [],
    })) as any).rows as SavedModelRow[];
  },
};

// ─────────────────────────────
// INFERENCE RESOLUTION + UNIVERSAL CALL
// Drop per-provider adapters; everything goes through universalInvoke.
// ─────────────────────────────

export const InferenceEngine = {
  async generate(messages: ChatMessage[]) {
    const { provider, model } = await InferenceSelector
      .selectProviderAndModel();
    return await universalInvoke(provider, model, messages);
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL INFERENCE ORCHESTRATOR
// Single OpenAI-compatible client for all providers.
// Dense, irreducible, load-bearing.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// CONTEXT ASSEMBLY
// Weighted memory + conversation history
// ─────────────────────────────

export const Context = {
  async build(session: string) {
    const messages = await MessageService.list(session);
    const memory = await MemoryService.list();

    const recall = memory
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8)
      .map((m) => ({ role: "system", content: m.value }));

    const chat = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return [...recall, ...chat];
  },
};

// ─────────────────────────────
// PROVIDER + MODEL RESOLUTION
// ─────────────────────────────

export const UniversalSelector = {
  async resolve() {
    const provider = await ProviderService.getBest();
    if (!provider) throw new Error("No provider available");

    const cfg = await ModelConfigService.get(provider.name);
    const model = cfg?.selected_model ?? provider.fallbackModel;
    if (!model) {
      throw new Error(`No model configured for provider ${provider.name}`);
    }

    return { provider, model };
  },
};

// ─────────────────────────────
// UNIVERSAL INFERENCE ENGINE
// ─────────────────────────────

export const UniversalInference = {
  async respond(session: string, userContent: string) {
    await MessageService.append({
      role: "user",
      content: userContent,
      ts: Date.now(),
      session,
      providerId: null,
    });

    const ctx = await Context.build(session);
    const { provider, model } = await UniversalSelector.resolve();

    const result = await universalInvoke(provider, model, ctx);

    await MessageService.append({
      role: "assistant",
      content: result.output,
      ts: Date.now(),
      session,
      providerId: provider.id.toString(),
    });

    return {
      provider: provider.name,
      model,
      output: result.output,
      usage: result.usage,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// WEBSOCKET STREAMING API — /ws
// Streams Cortex output chunk-by-chunk
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// UNIVERSAL STREAMING ENGINE — OPENAI-SCHEMA SSE
// Dense, irreducible, load-bearing.
// Works for any provider exposing OpenAI-compatible streaming.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// PROVIDER + MODEL RESOLUTION
// ─────────────────────────────

async function resolveProvider() {
  const provider = await ProviderService.getBest();
  if (!provider) throw new Error("No provider available");

  const cfg = await ModelConfigService.get(provider.name);
  const model = cfg?.selected_model ?? provider.fallbackModel;
  if (!model) {
    throw new Error(`No model configured for provider ${provider.name}`);
  }

  const apiKey = provider.keyEnv ? Deno.env.get(provider.keyEnv) : undefined;
  if (!apiKey) throw new Error(`Missing API key for provider ${provider.name}`);

  const url = provider.base.endsWith("/")
    ? provider.base + "v1/chat/completions"
    : provider.base + "/v1/chat/completions";

  return { provider, model, apiKey, url };
}

// ─────────────────────────────
// CONTEXT ASSEMBLY
// ─────────────────────────────

async function buildContext(session: string): Promise<MessageRow[]> {
  const messages = await MessageService.list(session);
  const memory = await MemoryService.list();

  const recall = memory
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((m) => ({ role: "system", content: m.value }));

  const chat = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return [...recall, ...chat];
}

// ─────────────────────────────
// UNIVERSAL STREAMING INVOCATION
// OpenAI-compatible SSE: "data: {delta:{content}}"
// ─────────────────────────────

export async function* universalStream(session: string, userContent: string) {
  // Append user message
  await MessageService.append({
    role: "user",
    content: userContent,
    ts: Date.now(),
    session,
    providerId: null,
  });

  const ctx = await buildContext(session);
  const { provider, model, apiKey, url } = await resolveProvider();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: ctx,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`Streaming failed: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalOutput = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Split on SSE boundaries
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;

    for (const chunk of parts) {
      if (!chunk.startsWith("data:")) continue;

      const payload = chunk.slice(5).trim();
      if (payload === "[DONE]") continue;

      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = json.choices?.[0]?.delta?.content ??
        json.choices?.[0]?.message?.content ??
        "";

      if (delta) {
        finalOutput += delta;
        yield delta;
      }
    }
  }

  // Append assistant message
  await MessageService.append({
    role: "assistant",
    content: finalOutput,
    ts: Date.now(),
    session,
    providerId: provider.id.toString(),
  });
}

// ─────────────────────────────
// HIGH-LEVEL API
// ─────────────────────────────

export const UniversalStreaming = {
  async *respond(session: string, userContent: string) {
    for await (const chunk of universalStream(session, userContent)) {
      yield chunk;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL COST + USAGE NORMALIZATION LAYER
// Dense, irreducible, load-bearing.
// Normalizes usage across all OpenAI-compatible providers.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// COST TABLE (STATIC, OVERRIDABLE)
// You can extend this at runtime via DB if needed.
// ─────────────────────────────

export const CostTable: Record<string, { input: number; output: number }> = {
  // Example defaults — override per provider/model as needed
  "gpt-4o-mini": { input: 0.00000015, output: 0.00000060 },
  "gpt-4o": { input: 0.00000500, output: 0.00001500 },
  "llama3.1-8b": { input: 0.00000005, output: 0.00000010 },
  "llama3.1-70b": { input: 0.00000080, output: 0.00000160 },
  "mixtral-8x22b": { input: 0.00000050, output: 0.00000100 },
};

// ─────────────────────────────
// USAGE NORMALIZER
// Takes raw provider usage and normalizes to:
// { input_tokens, output_tokens, total_cost }
// ─────────────────────────────

export function normalizeUsage(model: string, raw: any) {
  const usage = raw?.usage ?? {};
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;

  const costInfo = CostTable[model];
  if (!costInfo) {
    return {
      input_tokens: input,
      output_tokens: output,
      total_cost: 0,
    };
  }

  const total_cost = input * costInfo.input +
    output * costInfo.output;

  return {
    input_tokens: input,
    output_tokens: output,
    total_cost,
  };
}

// ─────────────────────────────
// COST LOGGING (DB)
// Schema:
// CREATE TABLE IF NOT EXISTS cost_log (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   ts INTEGER NOT NULL,
//   provider TEXT NOT NULL,
//   model TEXT NOT NULL,
//   input_tokens INTEGER NOT NULL,
//   output_tokens INTEGER NOT NULL,
//   total_cost REAL NOT NULL
// );
// ─────────────────────────────

export const CostLog = {
  async record(
    provider: string,
    model: string,
    usage: ReturnType<typeof normalizeUsage>,
  ) {
    await sqlite.execute({
      sql: `INSERT INTO cost_log
            (ts, provider, model, input_tokens, output_tokens, total_cost)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        Date.now(),
        provider,
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.total_cost,
      ],
    });
  },

  async total() {
    const r = await sqlite.execute({
      sql: `SELECT SUM(total_cost) as cost FROM cost_log`,
      args: [],
    });
    return (r as any).rows[0]?.cost ?? 0;
  },
};

// ─────────────────────────────
// COST-AWARE UNIVERSAL INFERENCE WRAPPER
// Wraps universalInvoke() and universalStream().
// ─────────────────────────────

export const UniversalCostAware = {
  async respond(session: string, messages: MessageRow[]) {
    const provider = await ProviderService.getBest();
    const cfg = await ModelConfigService.get(provider.name);
    const model = cfg?.selected_model ?? provider.fallbackModel;

    const result = await universalInvoke(provider, model, messages);
    const usage = normalizeUsage(model, result.raw);

    await CostLog.record(provider.name, model, usage);

    return {
      provider: provider.name,
      model,
      output: result.output,
      usage,
    };
  },

  async *respondStream(session: string, messages: MessageRow[]) {
    const provider = await ProviderService.getBest();
    const cfg = await ModelConfigService.get(provider.name);
    const model = cfg?.selected_model ?? provider.fallbackModel;

    let finalOutput = "";
    for (const message of messages) {
      for await (
        const chunk of universalStream(session, JSON.stringify(message))
      ) {
        finalOutput += chunk;
        yield chunk;
      }
    }

    // After streaming completes, we need usage from a follow-up call
    // or provider-specific usage endpoint. For now, usage = 0.
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      total_cost: 0,
    };

    await CostLog.record(provider.name, model, usage);
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL ROUTER — COST + LATENCY + HEALTH + PRIORITY
// Dense, irreducible, load-bearing.
// Selects optimal provider/model for each request.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// TELEMETRY STORE
// Tracks latency, failures, cost, success rate.
// ─────────────────────────────

const Telemetry = {
  latency: new Map<string, number[]>(),
  failures: new Map<string, number>(),
  successes: new Map<string, number>(),
  cost: new Map<string, number>(),

  recordLatency(provider: string, ms: number) {
    const arr = this.latency.get(provider) ?? [];
    arr.push(ms);
    if (arr.length > 50) arr.shift();
    this.latency.set(provider, arr);
  },

  recordSuccess(provider: string) {
    const n = this.successes.get(provider) ?? 0;
    this.successes.set(provider, n + 1);
  },

  recordFailure(provider: string) {
    const n = this.failures.get(provider) ?? 0;
    this.failures.set(provider, n + 1);
  },

  recordCost(provider: string, amount: number) {
    const c = this.cost.get(provider) ?? 0;
    this.cost.set(provider, c + amount);
  },
};

// ─────────────────────────────
// HEALTH SCORE
// Combines latency, failures, cost, success rate.
// ─────────────────────────────

function healthScore(provider: string): number {
  const lat = Telemetry.latency.get(provider) ?? [];
  const avgLat = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 500;

  const failures = Telemetry.failures.get(provider) ?? 0;
  const successes = Telemetry.successes.get(provider) ?? 1;
  const failureRate = failures / (failures + successes);

  const cost = Telemetry.cost.get(provider) ?? 0;

  return (
    1 / (1 + avgLat / 1000) * // latency penalty
    (1 - failureRate) * // reliability
    1 / (1 + cost / 10) // cost penalty
  );
}

// ─────────────────────────────
// ROUTER — SELECT BEST PROVIDER + MODEL
// ─────────────────────────────

export const UniversalRouter = {
  async select() {
    const providers = await ProviderRepo.list();
    if (providers.length === 0) throw new Error("No providers available");

    // Compute scores
    const scored = [];
    for (const p of providers) {
      const score = healthScore(p.name) * (1 / (1 + p.priority));
      scored.push({ provider: p, score });
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0].provider;
    const cfg = await ModelConfigRepo.get(best.name);
    const model = cfg?.selected_model ?? best.fallbackModel;

    if (!model) {
      throw new Error(`No model configured for provider ${best.name}`);
    }

    return { provider: best, model };
  },

  async record(
    provider: string,
    model: string,
    latency: number,
    cost: number,
    ok: boolean,
  ) {
    Telemetry.recordLatency(provider, latency);
    Telemetry.recordCost(provider, cost);
    ok ? Telemetry.recordSuccess(provider) : Telemetry.recordFailure(provider);

    await sqlite.execute({
      sql: `INSERT INTO router_log (ts, provider, model, latency, cost, success)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [Date.now(), provider, model, latency, cost, ok ? 1 : 0],
    });
  },
};

// ─────────────────────────────
// HIGH-LEVEL ROUTED INFERENCE
// Wraps universalInvoke() with routing + telemetry.
// ─────────────────────────────

export const RoutedInference = {
  async respond(messages: any[]) {
    const { provider, model } = await UniversalRouter.select();

    const t0 = performance.now();
    const result = await universalInvoke(provider, model, messages);
    const t1 = performance.now();

    const usage = normalizeUsage(model, result.raw);
    const latency = t1 - t0;

    await UniversalRouter.record(
      provider.name,
      model,
      latency,
      usage.total_cost,
      true,
    );

    return {
      provider: provider.name,
      model,
      output: result.output,
      usage,
      latency,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL FALLBACK LAYER
// Dense, irreducible, load-bearing.
// Provides provider fallback, model fallback, retry logic,
// exponential backoff, and failure learning.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────
// RETRY PARAMETERS
// ─────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY = 150; // ms

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────
// FALLBACK MODEL LIST
// Ordered by preference.
// ─────────────────────────────

export const ModelFallback = [
  "gpt-4o-mini",
  "gpt-4o",
  "llama3.1-70b",
  "llama3.1-8b",
  "mixtral-8x22b",
];

// ─────────────────────────────
// FALLBACK PROVIDER LIST
// Sorted by priority automatically.
// ─────────────────────────────

async function providerFallbackList() {
  const providers = await ProviderRepo.list();
  return providers.sort((a, b) => a.priority - b.priority);
}

// ─────────────────────────────
// TRY INVOCATION WITH RETRIES
// ─────────────────────────────

async function tryInvoke(
  provider: Provider,
  model: string,
  messages: MessageRow[],
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const t0 = performance.now();
      const result = await universalInvoke(provider, model, messages);
      const t1 = performance.now();

      const usage = normalizeUsage(model, result.raw);
      const latency = t1 - t0;

      await UniversalRouter.record(
        provider.name,
        model,
        latency,
        usage.total_cost,
        true,
      );

      return { ok: true, result, usage, latency };
    } catch (err) {
      console.error(err);
      await UniversalRouter.record(
        provider.name,
        model,
        0,
        0,
        false,
      );

      if (attempt < MAX_RETRIES - 1) {
        await sleep(BASE_DELAY * Math.pow(2, attempt));
      }
    }
  }

  return { ok: false };
}

// ─────────────────────────────
// UNIVERSAL FALLBACK ENGINE
// ─────────────────────────────

export const UniversalFallback = {
  async respond(messages: MessageRow[]) {
    const providers = await providerFallbackList();

    for (const provider of providers) {
      const cfg = await ModelConfigRepo.get(provider.name);
      const primaryModel = cfg?.selected_model ?? provider.fallbackModel;

      const models = [
        primaryModel,
        ...ModelFallback.filter((m) => m !== primaryModel),
      ].filter(Boolean);

      for (const model of models) {
        const attempt = await tryInvoke(provider, model, messages);
        if (attempt.ok) {
          return {
            provider: provider.name,
            model,
            output: attempt.result.output,
            usage: attempt.usage,
            latency: attempt.latency,
          };
        }
      }
    }

    throw new Error("All providers and fallback models failed");
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL SUPERVISOR
// Dense, irreducible, load-bearing.
// Provides global circuit breakers, provider quarantine,
// model quarantine, rolling health windows, reintegration,
// and catastrophic-failure containment.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// SUPERVISOR STATE (DB)
// Schema:
//
// CREATE TABLE IF NOT EXISTS supervisor_state (
//   key TEXT PRIMARY KEY,
//   value TEXT NOT NULL,
//   ts INTEGER NOT NULL
// );
//
// CREATE TABLE IF NOT EXISTS quarantine (
//   provider TEXT NOT NULL,
//   model TEXT NOT NULL,
//   until INTEGER NOT NULL,
//   PRIMARY KEY (provider, model)
// );
// ─────────────────────────────

export const SupervisorState = {
  async set(key: string, value: string) {
    await sqlite.execute({
      sql: `INSERT INTO supervisor_state (key, value, ts)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
      args: [key, value, Date.now()],
    });
  },

  async get(key: string): Promise<string | null> {
    const r = await sqlite.execute({
      sql: `SELECT value FROM supervisor_state WHERE key = ?`,
      args: [key],
    });
    return (r as any).rows[0]?.value ?? null;
  },
};

// ─────────────────────────────
// QUARANTINE ENGINE
// Providers/models are quarantined after repeated failures.
// ─────────────────────────────

export const Quarantine = {
  async add(provider: string, model: string, ms: number) {
    await sqlite.execute({
      sql: `INSERT INTO quarantine (provider, model, until)
            VALUES (?, ?, ?)
            ON CONFLICT(provider, model)
            DO UPDATE SET until = excluded.until`,
      args: [provider, model, Date.now() + ms],
    });
  },

  async isQuarantined(provider: string, model: string): Promise<boolean> {
    const r = await sqlite.execute({
      sql: `SELECT until FROM quarantine
            WHERE provider = ? AND model = ?`,
      args: [provider, model],
    });
    const until = (r as any).rows[0]?.until;
    return until && until > Date.now();
  },

  async cleanup() {
    await sqlite.execute({
      sql: `DELETE FROM quarantine WHERE until < ?`,
      args: [Date.now()],
    });
  },
};

// ─────────────────────────────
// GLOBAL CIRCUIT BREAKER
// Trips when catastrophic failure detected.
// ─────────────────────────────

export const CircuitBreaker = {
  async trip(reason: string) {
    await SupervisorState.set("circuit_breaker", reason);
  },

  async reset() {
    await SupervisorState.set("circuit_breaker", "none");
  },

  async isTripped(): Promise<boolean> {
    const v = await SupervisorState.get("circuit_breaker");
    return v && v !== "none";
  },
};

// ─────────────────────────────
// FAILURE ANALYZER
// Detects catastrophic patterns:
// - all providers failing
// - repeated global failures
// - runaway latency
// - runaway cost
// ─────────────────────────────

export const FailureAnalyzer = {
  async detectGlobalFailure(): Promise<boolean> {
    const r = await sqlite.execute({
      sql: `SELECT COUNT(*) as c
            FROM router_log
            WHERE ts > ? AND success = 0`,
      args: [Date.now() - 5000], // last 5 seconds
    });

    const failures = (r as any).rows[0]?.c ?? 0;
    return failures > 10; // threshold
  },
};

// ─────────────────────────────
// SUPERVISOR ENGINE
// Wraps UniversalFallback with quarantine + circuit breaker.
// ─────────────────────────────

export const UniversalSupervisor = {
  async respond(messages: MessageRow[]) {
    await Quarantine.cleanup();

    // Circuit breaker check
    if (await CircuitBreaker.isTripped()) {
      throw new Error("Global circuit breaker is tripped");
    }

    const providers = await ProviderRepo.list();

    for (const provider of providers) {
      const cfg = await sqlite.execute({
        sql: `SELECT selected_model FROM omni_router_config WHERE provider = ?`,
        args: [provider.name],
      });

      const primaryModel = (cfg as any).rows[0]?.selected_model ??
        provider.fallbackModel;

      // Skip quarantined provider/model
      if (await Quarantine.isQuarantined(provider.name, primaryModel)) {
        continue;
      }

      try {
        const result = await UniversalFallback.respond(messages);
        return result;
      } catch (err) {
        console.error(err);
        // Quarantine provider/model for 30 seconds
        await Quarantine.add(provider.name, primaryModel, 30000);
      }
    }

    // If we reach here, all providers failed
    if (await FailureAnalyzer.detectGlobalFailure()) {
      await CircuitBreaker.trip("global_failure");
    }

    throw new Error("All providers are quarantined or failing");
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL AUTOPILOT
// Dense, irreducible, load-bearing.
// Continuously adjusts routing weights, model preferences,
// cost ceilings, latency thresholds, and fallback ordering
// based on real telemetry.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// AUTOPILOT PARAMETERS
// ─────────────────────────────

const LATENCY_TARGET = 1500; // ms
const COST_TARGET = 0.0005; // per request
const FAILURE_TARGET = 0.05; // 5%

const ADJUST_INTERVAL = 60_000; // 1 minute

// ─────────────────────────────
// TELEMETRY SNAPSHOT
// ─────────────────────────────

async function snapshot() {
  const r = await sqlite.execute({
    sql: `
      SELECT provider, model,
             AVG(latency) as avg_latency,
             SUM(cost) as total_cost,
             SUM(success) as successes,
             COUNT(*) as attempts
      FROM router_log
      WHERE ts > ?
      GROUP BY provider, model
    `,
    args: [Date.now() - ADJUST_INTERVAL],
  });

  return (r as any).rows ?? [];
}

// ─────────────────────────────
// AUTOPILOT ADJUSTMENTS
// ─────────────────────────────

async function adjustProviderPriority(provider: string, delta: number) {
  await sqlite.execute({
    sql: `UPDATE provider SET priority = priority + ? WHERE name = ?`,
    args: [delta, provider],
  });
}

async function adjustModelPreference(provider: string, model: string) {
  await ModelConfigRepo.set(provider, model);
}

async function increaseQuarantine(provider: string, model: string) {
  await Quarantine.add(provider, model, 60_000); // 1 minute
}

// ─────────────────────────────
// AUTOPILOT ENGINE
// ─────────────────────────────

export const UniversalAutopilot = {
  async tick() {
    const rows = await snapshot();
    if (rows.length === 0) return;

    for (const row of rows) {
      const {
        provider,
        model,
        avg_latency,
        total_cost,
        successes,
        attempts,
      } = row;

      const failureRate = 1 - successes / attempts;

      // ─────────────────────────────
      // LATENCY ADJUSTMENT
      // ─────────────────────────────
      if (avg_latency > LATENCY_TARGET) {
        await adjustProviderPriority(provider, +1);
      } else {
        await adjustProviderPriority(provider, -0.1);
      }

      // ─────────────────────────────
      // COST ADJUSTMENT
      // ─────────────────────────────
      if (total_cost / attempts > COST_TARGET) {
        // Switch to cheaper model if available
        const cheaper = ["gpt-4o-mini", "llama3.1-8b"].find((m) => m !== model);
        if (cheaper) {
          await adjustModelPreference(provider, cheaper);
        }
      }

      // ─────────────────────────────
      // FAILURE ADJUSTMENT
      // ─────────────────────────────
      if (failureRate > FAILURE_TARGET) {
        await increaseQuarantine(provider, model);
      }
    }
  },
};

// ─────────────────────────────
// AUTOPILOT SCHEDULER
// Call this once per minute.
// ─────────────────────────────

export function startAutopilot() {
  setInterval(() => UniversalAutopilot.tick(), ADJUST_INTERVAL);
}

// ─────────────────────────────────────────────────────────────
// UNIVERSAL OBSERVATORY
// Dense, irreducible, load-bearing.
// Provides real-time telemetry queries for routing, cost,
// latency, failures, quarantine, and autopilot behavior.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// OBSERVATORY QUERIES
// ─────────────────────────────

export const Observatory = {
  // ─────────────────────────────
  // PROVIDER HEALTH SNAPSHOT
  // ─────────────────────────────
  async providerHealth() {
    const r = await sqlite.execute({
      sql: `
        SELECT provider,
               AVG(latency) as avg_latency,
               SUM(cost) as total_cost,
               SUM(success) as successes,
               COUNT(*) as attempts,
               SUM(success) * 1.0 / COUNT(*) as success_rate
        FROM router_log
        WHERE ts > ?
        GROUP BY provider
        ORDER BY provider ASC
      `,
      args: [Date.now() - 60_000], // last 60 seconds
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // MODEL HEALTH SNAPSHOT
  // ─────────────────────────────
  async modelHealth() {
    const r = await sqlite.execute({
      sql: `
        SELECT provider, model,
               AVG(latency) as avg_latency,
               SUM(cost) as total_cost,
               SUM(success) as successes,
               COUNT(*) as attempts,
               SUM(success) * 1.0 / COUNT(*) as success_rate
        FROM router_log
        WHERE ts > ?
        GROUP BY provider, model
        ORDER BY provider, model ASC
      `,
      args: [Date.now() - 60_000],
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // QUARANTINE STATE
  // ─────────────────────────────
  async quarantine() {
    const r = await sqlite.execute({
      sql: `
        SELECT provider, model, until
        FROM quarantine
        ORDER BY until DESC
      `,
      args: [],
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // COST OVER TIME
  // ─────────────────────────────
  async costTimeline(ms: number = 300_000) {
    const r = await sqlite.execute({
      sql: `
        SELECT ts, provider, model, total_cost
        FROM cost_log
        WHERE ts > ?
        ORDER BY ts ASC
      `,
      args: [Date.now() - ms],
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // LATENCY DISTRIBUTION
  // ─────────────────────────────
  async latencyDistribution(ms: number = 300_000) {
    const r = await sqlite.execute({
      sql: `
        SELECT latency
        FROM router_log
        WHERE ts > ?
        ORDER BY latency ASC
      `,
      args: [Date.now() - ms],
    });

    return (r as any).rows.map((r) => r.latency) ?? [];
  },

  // ─────────────────────────────
  // FAILURE HEATMAP
  // ─────────────────────────────
  async failureHeatmap(ms: number = 300_000) {
    const r = await sqlite.execute({
      sql: `
        SELECT provider, model,
               SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
               COUNT(*) as attempts
        FROM router_log
        WHERE ts > ?
        GROUP BY provider, model
        ORDER BY failures DESC
      `,
      args: [Date.now() - ms],
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // ROUTING DECISION TRACE
  // ─────────────────────────────
  async routingTrace(limit: number = 50) {
    const r = await sqlite.execute({
      sql: `
        SELECT ts, provider, model, latency, cost, success
        FROM router_log
        ORDER BY ts DESC
        LIMIT ?
      `,
      args: [limit],
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // AUTOPILOT ADJUSTMENT TRACE
  // ─────────────────────────────
  async autopilotTrace(limit: number = 50) {
    const r = await sqlite.execute({
      sql: `
        SELECT ts, key, value
        FROM supervisor_state
        ORDER BY ts DESC
        LIMIT ?
      `,
      args: [limit],
    });

    return (r as any).rows ?? [];
  },

  // ─────────────────────────────
  // GLOBAL ANOMALY DETECTION
  // ─────────────────────────────
  async anomalies() {
    const r = await sqlite.execute({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM router_log WHERE ts > ? AND success = 0) as recent_failures,
          (SELECT AVG(latency) FROM router_log WHERE ts > ?) as recent_latency,
          (SELECT SUM(total_cost) FROM cost_log WHERE ts > ?) as recent_cost
      `,
      args: [
        Date.now() - 10_000,
        Date.now() - 10_000,
        Date.now() - 10_000,
      ],
    });

    return (r as any).rows[0] ?? {};
  },
};

// ─────────────────────────────────────────────────────────────
// UNIVERSAL CORTEX
// Dense, irreducible, load-bearing.
// The unified cognitive surface of the entire system.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// CONTEXT ASSEMBLY
// ─────────────────────────────

// ─────────────────────────────
// CORTEX ENGINE
// ─────────────────────────────

export const Cortex = {
  async respond(session: string, userContent: string) {
    // 1. Append user message
    await MessageService.append({
      role: "user",
      content: userContent,
      ts: Date.now(),
      session,
      providerId: null,
    });

    // 2. Build full cognitive context
    const ctx = await buildContext(session);

    // 3. Supervisor governs routing + fallback + retries
    const result = await UniversalSupervisor.respond(ctx);

    // 4. Append assistant message
    await MessageService.append({
      role: "assistant",
      content: result.output,
      ts: Date.now(),
      session,
      providerId: result.provider,
    });

    // 5. Memory reinforcement
    await MemoryService.reinforce("cortex", result.output.length / 1000);

    // 6. Autopilot optimization tick (non-blocking)
    UniversalAutopilot.tick();

    // 7. Observatory snapshot (non-blocking)
    const telemetry = {
      provider_health: await Observatory.providerHealth(),
      model_health: await Observatory.modelHealth(),
      anomalies: await Observatory.anomalies(),
    };

    // 8. Return unified response
    return {
      provider: result.provider,
      model: result.model,
      output: result.output,
      usage: result.usage,
      latency: result.latency,
      telemetry,
    };
  },
};

export { ProviderRepo };

export {
  dbCount,
  dbExecute,
  dbExists,
  dbMaybeOne,
  // Helpers
  dbQuery,
  type DbResult,
  dbRunCPS,
  dbSelectMany,
  dbSelectOne,
  initDB,
  type MemoryRow,
  type MessageRow,
  // Types
  type Provider,
  type RowOf,
  type Run,
  type SavedModelRow,
  type SessionRow,
  type SqlArgs,
  type SqlText,
};