// Inference client (moved from app.tsx for the 80k-char limit): in-process router call, request shaping, size-bound retries.
import { T } from "./timing.ts";
import { ROUTER_MIN_ATTEMPT_MS } from "./router-core.ts";
import routerHandler from "./router.tsx";
import type { Settings } from "./app-settings.ts";
import { normalizeMessages, shrinkMessages } from "./app-helpers.ts";

export const INFERENCE_URL = "https://router.val.run";
// The router is a module of this val. Calling it in-process removes the val→val HTTP hop entirely: Cloudflare in front of
// *.val.run blocks server-side fetches from Val Town's own egress ("Blocked", server: cloudflare) regardless of volume,
// and every hop was also a second 60 s wall clock and a second invocation. HTTP is used only for a custom router URL.
/** Call the router — in-process when it is this val, over HTTP when `routerUrl` points elsewhere.
 *
 *  The external branch MUST carry a timeout. Without one it was a bare `fetch(url, init)` that could hang
 *  for as long as the remote router took to answer, and nothing upstream could interrupt it: the retry
 *  loop's `deadlineMs` checks run only BETWEEN retries, and `omni_deadline_ms` is advisory — it asks the
 *  remote router to bound ITSELF, which is worthless precisely when that router is the thing wedged. The
 *  in-process branch was always bounded (routeInference's SAFETY_CEILING_MS); the HTTP branch was not.
 *
 *  The consequence is a 502 that looks like the app's fault and is not: the fetch outlives Val Town's
 *  ~60s kill, the isolate dies without writing a response, and Cloudflare reports "Bad gateway" with the
 *  HOST marked as the error source. That is unrecoverable by design — a killed isolate cannot report
 *  anything — so the only fix is to never reach the kill. Abort first and surface a real error instead. */
/** What this loop spends around a router call that the router's own clock never sees: serializing the
 *  body, the request, and reading the response back. Reserved on both sides of every budget decision. */
const TRANSPORT_MARGIN_MS = T.transportMargin;
export const routerCall = (
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> => {
  if (url.replace(/\/$/, "") === INFERENCE_URL || !url) {
    return routerHandler(
      new Request(INFERENCE_URL + "/v1/chat/completions", init),
    );
  }
  if (!timeoutMs || timeoutMs <= 0) return fetch(url, init);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ac.signal })
    .catch((e) => {
      if (ac.signal.aborted) {
        throw Object.assign(
          new Error(
            `ROUTER_TIMEOUT: ${url} did not answer within ${
              Math.round(timeoutMs / 1000)
            }s`,
          ),
          { status: 504, retryable: true },
        );
      }
      throw e;
    })
    .finally(() => clearTimeout(timer));
};

// ════════════════════════════════════════════════════════════════════════════
//  INFERENCE  (accepts optional model override for the verifier pass)
// ════════════════════════════════════════════════════════════════════════════
export interface InferResult {
  message: any;
  finishReason: string;
  reasoning?: string; // model "thinking" (gpt-oss `reasoning`, qwen/deepseek `reasoning_content`)
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  meta: {
    provider?: unknown;
    model?: string;
    latencyMs?: number;
    retries?: number;
    instance?: string;
    maxTokensSent?: number | null;
    maxTokensAsked?: number;
    finishReason?: string;
    tokensOut?: number | null;
    tokensIn?: number | null;
    // Routing flowchart material, straight from router-core.ts's trail (via router-openai.ts's _omni_meta) —
    // plan is the intended provider order, attempts is what actually happened (tried/skipped, ok/failed, timing).
    plan?: string[];
    attempts?: {
      provider: string;
      vendor: string;
      model: string;
      pass: number;
      timeoutMs: number;
      ok: boolean;
      skipped?: boolean;
      demoted?: boolean;
      latencyMs?: number;
      error?: string;
      ts: number;
    }[];
  };
}
export interface GenOpts {
  reasoning?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  expect?: number;
  router?: Settings["router"];
  maxMode?: Settings["maxMode"];
  keyPolicy?: Settings["keyPolicy"];
  vendorOrder?: string[];
  exclude?: string[];
}
// Long-output requests (code, apps, documents) need throughput, not just quality:
// the router ranks by quality among vendors whose eta fits the deadline.
export const BUILD_RX =
  /\b(create|build|write|implement|generate|make|design|code|app|renderer|shader|script|component|page|game|simulat|program|class|function|refactor|port|convert)\b/i;
export const expectTokens = (messages: unknown[]) => {
  const last = [...messages].reverse().find((m: any) =>
    m?.role === "user"
  ) as any;
  return BUILD_RX.test(String(last?.content ?? "")) ? 6000 : 1500;
};
export async function callInference(
  messages: unknown[],
  tools?: unknown[],
  model?: string | null,
  deadlineMs?: number,
  gen: GenOpts = {},
): Promise<InferResult> {
  // The caller's clock starts on the FIRST line, for the same reason the router's now does: everything
  // between entry and the first outbound request — prompt normalisation, token estimation, body
  // assembly — is time the caller's grant is already being spent on, and a clock started after it is a
  // clock that under-reports. It was declared 20 lines down, after all of that work.
  const t0 = Date.now();
  // Ask for the most output the task can use; the router shrinks max_tokens to a
  // vendor's per-request/TPM limit and retries, and PassMeter auto-continues on
  // finish_reason "length", so a big request degrades to more passes, not an error.
  const expect = gen.expect ?? expectTokens(messages);
  // max_tokens policy — auto: size to task (router clamps to vendor/learned caps); fixed: the user's number; max: ask for the ceiling and let the router clamp.
  const maxTokens = gen.maxMode === "max"
    ? 65_536
    : gen.maxMode === "fixed" && gen.maxTokens
    ? gen.maxTokens
    : (gen.maxTokens ?? (expect >= 6000 ? 16_000 : 4_000));
  const body: Record<string, unknown> = {
    messages: normalizeMessages(messages),
    max_tokens: maxTokens,
    omni_expect_tokens: expect,
  };
  const routerUrl = gen.router?.url ?? INFERENCE_URL;
  const routerHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(gen.router?.key ? { authorization: `Bearer ${gen.router.key}` } : {}),
  };
  if (deadlineMs) {
    body.omni_deadline_ms = deadlineMs;
    // The duration is re-based when it lands — after DNS, TLS and transport — so the router's budget
    // silently grows by the flight time on every hop. The instant does not move. Both are sent: older
    // routers read the duration, this one prefers the instant.
    body.omni_deadline_at = t0 + deadlineMs;
  }
  if (gen.keyPolicy) body.omni_key_policy = gen.keyPolicy;
  if (gen.vendorOrder?.length) body.omni_vendor_order = gen.vendorOrder;
  if (gen.exclude?.length) body.omni_exclude = gen.exclude;
  if (tools?.length) body.tools = tools;
  if (model) body.model = model;
  if (gen.reasoning) body.reasoning_effort = gen.reasoning;
  if (typeof gen.temperature === "number") body.temperature = gen.temperature;
  let lastErr: Error = new Error("unreachable");
  let shrinks = 0;
  // Carried across retries so a call that eventually throws (after all 4 client-side retries) still reports
  // the last router pass's routing trail, instead of the flowchart going dark exactly when it matters most.
  let lastPlan: string[] | undefined;
  let lastAttempts: InferResult["meta"]["attempts"];
  for (let retry = 0; retry < 4; retry++) {
    if (retry) {
      // Prompt-size exhaustion: the vendors that are left cannot take this prompt, so make the prompt fit —
      // drop oldest history, trim tool payloads — and try again at once instead of burning retries on an
      // identical, unwinnable resend.
      //
      // This regex previously looked for "prompt ≈N tok > maxIn" / "too large" / "input limit" / "maxIn" —
      // a message format router-core.ts and router-openai.ts never actually produce anywhere (confirmed:
      // no occurrence of any of those substrings in either file). ALL_PROVIDERS_EXHAUSTED just concatenates
      // each provider's own raw upstream error text (router-core.ts's `errors.push(`${p.name}: ${e.message}`)`),
      // so the old regex could never match and shrinkMessages() below had exactly one call site — this whole
      // branch was dead code; every size-exhausted request instead fell through to the generic retry path and
      // resent the identical oversized prompt up to 4 times, guaranteed to fail identically each time, burning
      // the wall-clock budget until the loop's own deadline check gave up. Replaced with patterns actually
      // observed live this session (a real Groq 413: "Request too large ... please reduce your message size
      // and try again") plus the standard phrasings other vendors use for the same failure.
      //const sizeBound = /reduce (?:your|the) (?:message|prompt) size|request too large|prompt is too long|too many tokens|context_length_exceeded|maximum context length|exceeds the (?:model'?s? )?(?:context|token) (?:length|limit)|input (?:is )?too long/i.test(lastErr.message) && (lastErr as any).status === 503;
      const sizeBound =
        /reduce (?:your|the) (?:message|prompt) size|request too large|prompt is too long|too many tokens|context_length_exceeded|maximum context length|exceeds the (?:model'?s? )?(?:context|token) (?:length|limit)|input (?:is )?too long/i
          .test(lastErr.message) &&
        [400, 413, 422, 503].includes((lastErr as any).status);
      if (sizeBound && shrinks < 2) {
        shrinks++;
        body.messages = shrinkMessages(body.messages as any[], shrinks);
        body.omni_expect_tokens = Math.min(expect, 2000);
      }
      const wait = sizeBound ? 0 : 1200 * retry;
      // THE NO_BUDGET BUG. This guard used a literal 4000 while the router refuses to contact a single
      // provider with less than ROUTER_MIN_ATTEMPT_MS (5000). So it admitted a retry whenever 4000ms
      // remained after the wait, handed the router 4000-4999ms, and the router - correctly - contacted
      // ZERO of 34 providers and returned NO_BUDGET. The user saw "ALL_PROVIDERS_EXHAUSTED", a
      // provider-shaped message for this loop's own arithmetic, on a call whose caller had honestly
      // granted a full 20s. The observed deadlineMs=4147 sits exactly in that window.
      //
      // TRANSPORT_MARGIN_MS is the round trip this loop spends BEFORE the router starts its own clock:
      // serializing the body, the request itself, and the response read. Budget left after the wait must
      // cover that AND a whole attempt, or there is no point starting.
      if (
        deadlineMs &&
        deadlineMs - (Date.now() - t0) - wait <
          ROUTER_MIN_ATTEMPT_MS + TRANSPORT_MARGIN_MS
      ) {
        // "No provider is at fault" was wrong whenever a provider HAD already failed: something consumed
        // the budget, and naming it is the difference between a diagnosable report and a shrug. The
        // previous error is carried through, because it is the reason there was a retry at all.
        const spent = Math.round(Date.now() - t0);
        const prior = String(lastErr?.message ?? "").slice(0, 220);
        lastErr = Object.assign(
          new Error(
            `out of time after ${retry} ${retry === 1 ? "retry" : "retries"}: ${
              Math.max(0, Math.round(deadlineMs - (Date.now() - t0)))
            }ms left of the ${deadlineMs}ms this call was given (${spent}ms spent), and an attempt needs ${ROUTER_MIN_ATTEMPT_MS}ms plus ${TRANSPORT_MARGIN_MS}ms of transport.` +
              (prior && prior !== "unreachable"
                ? ` What spent it: ${prior}`
                : " Nothing was retried; the first attempt consumed the grant."),
          ),
          { status: 503, budget: true, plan: lastPlan, attempts: lastAttempts },
        );
        break;
      }
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (deadlineMs) {
        body.omni_deadline_ms = deadlineMs - (Date.now() - t0);
        body.omni_deadline_at = t0 + deadlineMs; // unchanged across retries, by construction
      }
    }
    try {
      // Bound the remote call by what is actually left of this turn, with a 2s margin so the abort fires
      // before the caller's own deadline rather than after it.
      // Floored at a whole attempt, not at 1_000: a 1s abort on a call the router cannot answer in 1s
      // produced ROUTER_TIMEOUT for the same reason the guard above produced NO_BUDGET. The guard
      // guarantees there is at least this much left, so the floor is reachable, never invented.
      const leftMs = deadlineMs
        ? Math.max(
          ROUTER_MIN_ATTEMPT_MS,
          deadlineMs - (Date.now() - t0) - TRANSPORT_MARGIN_MS,
        )
        : 0;
      const res = await routerCall(routerUrl, {
        method: "POST",
        headers: routerHeaders,
        body: JSON.stringify(body),
      }, leftMs);
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch { /* non-JSON */ }
      if (!res.ok || !json?.choices?.[0]) {
        // An HTML body is an edge/WAF page (Val Town "Blocked", Cloudflare challenge), not the router: report its title + who served it, never the markup.
        const html = /^\s*<(?:!doctype|html)/i.test(text);
        const detail = json?.error
          ? (typeof json.error === "string"
            ? json.error
            : `${json.error.message}${
              json.error.details
                ? "\n" + [].concat(json.error.details).join("\n")
                : ""
            }`)
          : html
          ? `${routerUrl} answered with an HTML page "${
            (text.match(/<title>([^<]{1,80})<\/title>/i)?.[1] ?? "no title")
              .trim()
          }" (server: ${res.headers.get("server") ?? "?"}, cf-ray: ${
            res.headers.get("cf-ray") ?? "-"
          }) — the request was blocked before reaching the router; check https://router.val.run/health in a browser and the val's logs`
          : text.slice(0, 600);
        if (json?.error?.plan) lastPlan = json.error.plan;
        if (json?.error?.attempts) lastAttempts = json.error.attempts;
        lastErr = Object.assign(new Error(`router ${res.status}: ${detail}`), {
          status: res.status,
          html,
          plan: lastPlan,
          attempts: lastAttempts,
        });
        if (res.status === 404 || res.status === 400 || res.status === 401) {
          throw lastErr; // not retryable
        }
        continue;
      }
      const choice = json.choices[0];
      const m = choice.message ?? {};
      // Defense in depth: router-core.ts already rejects an empty/all-dot response before it can win a
      // provider race (see EMPTY_OR_DOT_RESPONSE there), but gen.router.url can point at a different,
      // custom router the user configured — this is the last checkpoint before an empty/junk reply would
      // otherwise be accepted as done. Treated exactly like a 503: retried, not silently returned.
      const omni = json._omni_meta;
      if (omni?.plan) lastPlan = omni.plan;
      if (omni?.attempts) lastAttempts = omni.attempts;
      const hasToolCalls = Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0;
      if (!hasToolCalls && typeof m.content === "string") {
        const stripped = m.content.replace(/\s+/g, "");
        if (stripped.length === 0 || /^\.+$/.test(stripped)) {
          lastErr = Object.assign(
            new Error(
              `router returned an empty/dot response from ${
                omni?.provider?.name ?? "an unknown provider"
              }`,
            ),
            { status: 503, plan: lastPlan, attempts: lastAttempts },
          );
          continue;
        }
      }
      return {
        message: m,
        finishReason: choice.finish_reason ?? "stop",
        reasoning: typeof m.reasoning === "string"
          ? m.reasoning
          : typeof m.reasoning_content === "string"
          ? m.reasoning_content
          : undefined,
        usage: json.usage,
        meta: {
          provider: omni?.provider,
          model: json.model,
          latencyMs: omni?.latency_ms,
          retries: retry,
          instance: omni?.instance ?? omni?.provider?.name,
          maxTokensSent: omni?.max_tokens_sent ?? maxTokens,
          maxTokensAsked: maxTokens,
          finishReason: choice.finish_reason ?? "stop",
          tokensOut: json.usage?.completion_tokens ?? null,
          tokensIn: json.usage?.prompt_tokens ?? null,
          plan: lastPlan,
          attempts: lastAttempts,
        },
      };
    } catch (e: any) {
      lastErr = e;
      if (e.status && ![503, 502, 500, 429].includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

// A metered wrapper: every inference call decrements a shared pass budget so no
// stage can silently blow past the hard ceiling. This is THE governor's teeth.