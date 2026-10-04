// The HTTP boundary, shared by both entrypoints (app.tsx and router.tsx).
//
// WHY THIS IS ITS OWN FILE, and why it matters more than it looks:
//
// Val Town invokes the module's default export and expects a Response back. If that function THROWS
// instead of returning, the platform has nothing to serve, and the caller receives an opaque Cloudflare
// 502 "Bad gateway" page. Nothing inside the val appears in it - no message, no stack, no route - so the
// failure looks like a network or hosting problem and gets debugged as one. Both entrypoints previously
// wrapped their work in `try { ... } finally { ... }` with NO `catch`, which meant every uncaught throw
// anywhere in either val - a bad JSON body, a null deref in a tool, a rejected DB call on a path that
// forgot to check `.ok` - surfaced as that same undiagnosable 502.
//
// A deadline guard alone does not close this. The guard answers when work takes too LONG; it does
// nothing when work FAILS FAST, and a fast throw is the more common case by far.
//
// Two distinct escapes are sealed here:
//   1. A rejection from the request body      -> caught, logged, returned as readable JSON.
//   2. A rejection from a floating promise    -> an unhandledrejection listener. In Deno an unhandled
//      rejection tears down the isolate, which kills whatever OTHER request happened to be in flight at
//      that moment and returns IT a 502. That victim request has no relationship to the code that threw,
//      which is what makes this class of failure look intermittent and unreproducible.

import { T } from "./timing.ts";

/** Statuses that describe the CALLER's request, so they pass through to the caller unchanged. Anything
 *  else an upstream said was about US, not about them, and is reported as a gateway failure. */
export const APP_OWNED_STATUSES = new Set([400, 429, 503]);

export function clientStatusFor(err: any): number {
  const s = Number(err?.status);
  if (!Number.isInteger(s) || s < 400 || s > 599) return 500;
  if (APP_OWNED_STATUSES.has(s)) return s;
  return 502; // upstream said something about US, not about the caller
}

/** Answer before Val Town's ~60s invocation kill. The remainder is not slack: it is the margin needed to
 *  serialize and write the response after the deadline fires. */
export const RESPONSE_DEADLINE_MS = T.responseDeadline;

export type BoundaryOpts = {
  /** Prefix for the deadline message, e.g. "TURN" or "ROUTER". */
  label: string;
  /** Extra lines shown to the user on both the deadline and the error path. */
  details?: string[];
};

/** Wrap a request handler so that it ALWAYS resolves to a Response - never rejects, never outlives the
 *  platform's patience. This is the only thing an entrypoint's default export should call. */
export function withBoundary(
  handle: (req: Request) => Promise<Response>,
  opts: BoundaryOpts,
): (req: Request) => Promise<Response> {
  const extra = opts.details ?? [];
  return async function boundary(req: Request): Promise<Response> {
    let timer: number | undefined;
    const guard = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(Response.json({
        error: {
          message: `${opts.label}_DEADLINE: the server hit its response deadline before finishing`,
          details: [
            `No reply within ${Math.round(RESPONSE_DEADLINE_MS / 1000)}s, so this request was ended deliberately rather than letting the platform kill it (which produces an unreadable 502 Bad Gateway page).`,
            ...extra,
          ],
        },
      }, { status: 503 })), RESPONSE_DEADLINE_MS) as unknown as number;
    });
    try {
      return await Promise.race([handle(req), guard]);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 400);
      console.error(`[${opts.label}] uncaught:`, msg, e?.stack ?? "");
      return Response.json({
        error: {
          message: `SERVER_ERROR: ${msg}`,
          details: [
            "This is the app failing, not the network - an earlier build let this same failure surface as a 502 Bad Gateway page with nothing in it to act on.",
            ...extra,
          ],
        },
      }, { status: clientStatusFor(e) });
    } finally {
      if (timer !== undefined) clearTimeout(timer); // never hold the isolate open on the losing timer
    }
  };
}

/** Registered once at module load by whichever entrypoint imports this. Swallowing the rejection is not
 *  hiding the bug - it is logged with its stack - it just stops one module's stray promise from killing
 *  an unrelated in-flight request. */
let installed = false;
export function installRejectionBackstop(): void {
  if (installed) return;
  installed = true;
  try {
    (globalThis as any).addEventListener?.("unhandledrejection", (e: any) => {
      e?.preventDefault?.();
      console.error("[unhandledrejection]", String(e?.reason?.message ?? e?.reason ?? e), e?.reason?.stack ?? "");
    });
  } catch { /* no event target in this runtime; withBoundary's catch still stands */ }
}
