import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

type Provider = {
  id: string;
  name: string;
  base: string;
  keyEnv: string;
  fallbackModel: string;
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

type SQL<T extends string> = { readonly sql: T };
type Arg<A extends any> = { readonly arg: A };
type Args<A extends Arg<A>> = { readonly args: A[] };

type DBResult<R> = { rows: R[] };

type RowOf<T extends string> = T extends
  `SELECT ${string} FROM messages ${string}` ? MessageRow
  : T extends `SELECT ${string} FROM memory ${string}` ? MemoryRow
  : T extends `SELECT ${string} FROM provider ${string}` ? Provider
  : T extends `SELECT ${string} FROM session ${string}` ? SessionRow
  : T extends `SELECT ${string} FROM message ${string}` ? MessageRow
  : T extends `SELECT ${string} FROM omni_router_config ${string}`
    ? SavedModelRow
  : unknown;

type Run = <Q extends string, A extends Args<any>>(
  q: SQL<Q> & Args<A>,
) => Promise<
  Q extends `SELECT ${string}` ? (<R>(k: (x: RowOf<Q>[]) => R) => R)
    : (<R>(k: (x: void) => R) => R)
>;

type Rows = <Q extends string, A extends any[]>(
  q: SQL<Q> & Args<A>,
) => Promise<RowOf<Q>[]>;

type Row = <Q extends string, A extends any>(
  q: SQL<Q> & Arg<A>,
) => Promise<RowOf<Q>>;

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
// DB helpers
// ─────────────────────────────

async function rowsAny<T = any | undefined>(
  sql: string,
  args: Args<any> | undefined[] = [],
): Promise<T[]> {
  const r = await sqlite.execute({ sql, args: args as any[] as Args<any> });
  return (r as any).rows as T[];
}

async function exec(sql: string, args: any[] = []): Promise<void> {
  await sqlite.execute({ sql, args });
}

export {
  type Args,
  type DBResult,
  exec,
  initDB,
  type MemoryRow,
  type MessageRow,
  type Provider,
  type RowOf,
  type Rows,
  rowsAny,
  type Run,
  type SavedModelRow,
  type SessionRow,
  type SQL,
};