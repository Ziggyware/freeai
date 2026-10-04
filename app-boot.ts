// HANDLERS AND SHARED HELPERS FOR EVERY ISOLATE THAT CAN TICK THE QUEUE.
//
// Why this file exists, concretely: the build/repair step kinds (design, plan, build, supervise, integrate,
// verify, goalcheck) are registered by app-build.ts, which needs the inference dependencies (PassMeter and
// the session helpers) — so registration lived inside app.tsx's request path. Every HTTP request called
// `wireBuild(...)`, so an isolate that served a request could run the queue... but the CRON val
// (scheduler-cron.ts) imports only scheduler-tasks.ts, which registers the GENERIC kinds. A job that was
// queued by a chat turn and then left alone reached an isolate where "build"/"goalcheck" had no handler at
// all, and every step of it failed with "no handler registered for kind" — which is exactly the behaviour
// "it stops working as soon as I stop watching" describes. Both entry points now import THIS module, so the
// handlers exist wherever a tick can happen.
//
// The dependency direction stays acyclic: this imports app-meter/app-helpers/app-build-wire, none of which
// import app.tsx. The HTTP entry point imports THIS instead of owning the helpers (clean/ensureSession),
// and the cron imports it before its first tick.
import { one, sql, touchSession, unwrap } from "./db.ts";
import { PassMeter } from "./app-meter.ts";
import { deriveTitle } from "./app-helpers.ts";
import { wireBuild } from "./app-build-wire.ts";

/** The one place a user-supplied string is normalised for storage. Same contract as before: strip NULs,
 *  trim, cap at 64k. Shared so a step running without an HTTP request behaves exactly like a turn. */
export function clean(s: string): string {
  return String(s ?? "").replace(/\u0000/g, "").trim().slice(0, 64_000);
}

/** Ensure a session row exists, creating it with the default name if it does not. A job step must be able
 *  to run for a session that has no live tab; the row it needs is created here, not by the browser. */
export async function ensureSession(id: string): Promise<{ id: string; name: string; ts: number }> {
  const sid = String(id || "default").slice(0, 200);
  const existing = unwrap(await one("session", sql`SELECT * FROM session WHERE id = ${sid}`), null) as
    | { id: string; name: string; ts: number }
    | null;
  if (existing) return existing;
  const row = { id: sid, name: "New Chat", ts: Date.now() };
  await touchSession(row.id, row.name, row.ts);
  return row;
}

let installed = false;

/** Register the build/repair step handlers. Idempotent: double registration would silently shadow. */
export function installHandlers(): void {
  if (installed) return;
  installed = true;
  wireBuild({ PassMeter, deriveTitle, clean, ensureSession });
}
