// Inference client (moved from app.tsx for the 80k-char limit): in-process router call, request shaping, size-bound retries.
import { T } from "./timing.ts";
import { ROUTER_MIN_ATTEMPT_MS } from "./router.ts";
import { chatCompletions } from "./router-api.ts";
import type { Settings } from "./app-settings.ts";
import { normalizeMessages, shrinkMessages } from "./app-helpers.ts";
import { env } from "./providers.ts";

/** This app's own public URL. The router is a MODULE of this app now, so this is
 *  not where inference goes — it is what an external client (omni-client.ts, an
 *  OpenAI SDK) should point at, and what error messages name. Override with
 *  OMNI_URL when the val is served from a custom domain. */
export const SELF_URL = (env("OMNI_URL") || "https://free-ai.val.run").replace(/\/+$/, "");
// There is deliberately no INFERENCE_URL any more. The name described a place
// inference was sent to, and that place is this file's own import of router-api.ts.
// Keeping it as an alias would keep alive the idea that there is somewhere else to
// point at, which is the idea this change removes. A saved `routerUrl` of the old
// router.val.run is folded back to "built-in" by app-settings.ts's normalizeRouter.

/** What this loop spends around a router call that the router's own clock never
 *  sees: serializing the body, the request, and reading the response back.
 *  Reserved on both sides of every budget decision. */
const TRANSPORT_MARGIN_MS = T.transportMargin;

export type RouterReply = {
  status: number;
  json: any;
  /** Raw body text. In-process this is the same object re-serialised, so the
   *  HTML/WAF check below can only ever fire on the external branch — which is
   *  the only branch where an edge can answer instead of the router. */
  text: string;
  header: (name: string) => string | null;
  /** False when the answer came from a router this app does not control. */
  inProcess: boolean;
};

/** Call the router — IN PROCESS, as a function, unless `url` points at a
 *  different router the operator configured.
 *
 *  This used to synthesise a `Request`, hand it to the router val's HTTP handler,
 *  and read the `Response` back: a loopback hop through withBoundary's second
 *  deadline timer, a second initDB(), a CORS header nobody would read, a
 *  JSON.stringify of the whole prompt and a JSON.parse of the whole reply — on
 *  every single model call the app makes. Both the serialize and the parse are
 *  gone now, and so is the second deadline competing with the first.
 *
 *  The EXTERNAL branch still has to be a fetch, and it MUST carry a timeout.
 *  Without one it hangs for as long as the remote router takes, and nothing
 *  upstream can interrupt it: the retry loop's `deadlineMs` checks run only
 *  BETWEEN retries, and `omni_deadline_ms` is advisory — it asks the remote
 *  router to bound ITSELF, which is worthless precisely when that router is the
 *  thing wedged. The consequence is a 502 that looks like the app's fault and is
 *  not: the fetch outlives Val Town's ~60 s kill, the isolate dies without
 *  writing a response, and Cloudflare reports "Bad gateway" with the HOST marked
 *  as the error source. Unrecoverable by design — a killed isolate cannot report
 *  anything — so the only fix is never to reach the kill. */
export async function routerRequest(url: string, body: Record<string, unknown>, timeoutMs?: number): Promise<RouterReply> {
  const target = (url || "").replace(/\/+$/, "");
  // Blank, our own origin, or our own origin + /v1 all mean "the built-in
  // router". Anything else is an operator-configured remote and goes over HTTP.
  if (!target || target === SELF_URL || target === `${SELF_URL}/v1`) {
    const r = await chatCompletions(body);
    return { status: r.status, json: r.json, text: JSON.stringify(r.json), header: () => null, inProcess: true };
  }
  const endpoint = /\/(v1\/)?chat\/completions$/.test(target) ? target : `${target}/v1/chat/completions`;
  const ac = new AbortController();
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // The key travels as a header, never in the body: a body is what gets logged.
    const { omni_auth: auth, ...rest } = body;
    if (typeof auth === "string" && auth) headers.authorization = `Bearer ${auth}`;
    const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(rest), signal: ac.signal });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* an edge page, not the router */ }
    return { status: res.status, json, text, header: (n) => res.headers.get(n), inProcess: false };
  } catch (e: any) {
    if (ac.signal.aborted) {
      throw Object.assign(
        new Error(`ROUTER_TIMEOUT: ${endpoint} did not answer within ${Math.round((timeoutMs ?? 0) / 1000)}s`),
        { status: 504, retryable: true },
      );
    }
    throw Object.assign(new Error(`ROUTER_UNREACHABLE: ${endpoint} — ${String(e?.message ?? e).slice(0, 200)}`), { status: 502, retryable: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    // Routing flowchart material, straight from router.ts's trail (via its _omni_meta) —
    // plan is the ranked provider order, attempts is what actually happened (tried/skipped,
    // ok/failed, which model id, timing), and skipped is what the router refused to call at all.
    plan?: string[];
    attempts?: {
      provider: string;
      vendor: string;
      model: string;
      /** 1 = the vendor's first model id, 2+ = a fallback within the same vendor. */
      pass: number;
      timeoutMs: number;
      ok: boolean;
      skipped?: boolean;
      latencyMs?: number;
      /** Parameters a 400 accused, which the retry then dropped. */
      dropped?: string[];
      error?: string;
      ts: number;
    }[];
    /** Candidates never called, with the reason: too small for the prompt,
     *  malformed secret, excluded, or every model id dead upstream. */
    skipped?: { name: string; vendor: string; why: string }[] | null;
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
  // Blank means the router built into this app, called as a function. A URL means
  // an operator pointed this deployment at a different router, which is the only
  // case that still needs HTTP — and the only case that needs an auth header,
  // since the in-process call cannot be gated by OMNI_CLIENT_KEYS (nor should it
  // be: it is the app talking to itself).
  const routerUrl = gen.router?.url ?? "";
  if (gen.router?.key) body.omni_auth = gen.router.key;
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
      // drop oldest history, trim tool payloads — and retry AT ONCE instead of burning retries on an
      // identical, unwinnable resend.
      //
      // Two signals, and the first is the one that matters. router.ts now refuses to call a vendor whose
      // declared (or learned) input ceiling the prompt exceeds, and says so with its own code — a
      // structured 413 PROMPT_TOO_LARGE. That replaces a regex guess over upstream prose, which is all
      // this branch used to have: the router never produced a size message of its own, so for one whole
      // revision the regex could not match anything, shrinkMessages() had no live call site, and every
      // oversized request resent itself four times identically until the wall clock ran out. The regex
      // stays as the second signal because a remote operator-configured router — or one vendor's own 413
      // inside a 503 exhaustion — still arrives as prose.
      const errAny = lastErr as any;
      const sizeBound = errAny.code === "PROMPT_TOO_LARGE" || errAny.status === 413 ||
        (/reduce (?:your|the) (?:message|prompt) size|request too large|prompt is too long|too many tokens|context_length_exceeded|maximum context length|exceeds the (?:model'?s? )?(?:context|token) (?:length|limit)|input (?:is )?too long|exceeds its \d+ tok input limit/i
            .test(lastErr.message) &&
          [400, 413, 422, 503].includes(errAny.status));
      if (sizeBound && shrinks < 2) {
        shrinks++;
        body.messages = shrinkMessages(body.messages as any[], shrinks);
        body.omni_expect_tokens = Math.min(expect, 2000);
      }
      const wait = sizeBound ? 0 : 1200 * retry;
      // A client-side retry is another complete routed request, not another provider fallback within the
      // current one. Start it only if the remaining grant can cover one minimum provider attempt plus the
      // serialization/request/response margin; router.ts separately reserves room for fallback
      // candidates inside each request.
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
      const res = await routerRequest(routerUrl, body, leftMs);
      const { text, json, status } = res;
      if (status < 200 || status > 299 || !json?.choices?.[0]) {
        // An HTML body is an edge/WAF page (Val Town "Blocked", a Cloudflare challenge), not the router:
        // report its title and who served it, never the markup. Only reachable on the external branch —
        // an in-process call has no edge in front of it.
        const html = /^\s*<(?:!doctype|html)/i.test(text);
        const errObj = json?.error;
        const detail = errObj
          ? (typeof errObj === "string"
            ? errObj
            : `${errObj.message}${
              errObj.details ? "\n" + [].concat(errObj.details).join("\n") : ""
            }${errObj.skipped?.length ? "\nskipped without a call: " + errObj.skipped.map((s: any) => `${s.name} (${s.why})`).join("; ") : ""}`)
          : html
          ? `${routerUrl || SELF_URL} answered with an HTML page "${
            (text.match(/<title>([^<]{1,80})<\/title>/i)?.[1] ?? "no title").trim()
          }" (server: ${res.header("server") ?? "?"}, cf-ray: ${
            res.header("cf-ray") ?? "-"
          }) — the request was blocked before reaching the router; open ${SELF_URL}/health in a browser and check the val's logs`
          : text.slice(0, 600);
        if (errObj?.plan) lastPlan = errObj.plan;
        if (errObj?.attempts) lastAttempts = errObj.attempts;
        lastErr = Object.assign(new Error(`router ${status}: ${detail}`), {
          status,
          code: errObj?.code ?? null,
          html,
          plan: lastPlan,
          attempts: lastAttempts,
          skipped: errObj?.skipped ?? null,
        });
        // 404 = the caller named a model that does not exist; 400 = the request
        // itself is malformed; 401 = a gate. None of these change by retrying, and
        // retrying them is how a 14 s turn burns itself on one immutable answer.
        // 413 (PROMPT_TOO_LARGE) deliberately DOES fall through to the retry path:
        // the shrink branch below turns it into a different, smaller request.
        if (status === 404 || status === 400 || status === 401) {
          throw lastErr;
        }
        continue;
      }
      const choice = json.choices[0];
      const m = choice.message ?? {};
      // Defense in depth: router.ts already rejects an empty/all-dot response before it can win a
      // provider race (see isEmptyOrDotContent there), but gen.router.url can point at a different,
      // custom router the operator configured — this is the last checkpoint before an empty/junk reply
      // would otherwise be accepted as done. Treated exactly like a 503: retried, not silently returned.
      // A reasoning-only reply is NOT empty: it is truncated, and the caller's auto-continue handles it.
      const omni = json._omni_meta;
      if (omni?.plan) lastPlan = omni.plan;
      if (omni?.attempts) lastAttempts = omni.attempts;
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      const thought = (typeof m.reasoning === "string" && m.reasoning.trim()) ||
        (typeof m.reasoning_content === "string" && m.reasoning_content.trim());
      if (!hasToolCalls && !thought && typeof m.content === "string") {
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
          // Providers the router refused to even call, with the reason. Surfacing
          // this is the difference between "the router is broken" and "your prompt
          // is 9k tokens and the widest vendor takes 6.5k" — which is a thing the
          // caller can fix and previously could not see.
          skipped: omni?.skipped ?? null,
        },
      };
    } catch (e: any) {
      lastErr = e;
      // 413 is PROMPT_TOO_LARGE: the shrink branch above turns the next attempt
      // into a different, smaller request, so it is retryable by construction.
      if (e.status && ![503, 502, 500, 429, 413].includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

// A metered wrapper: every inference call decrements a shared pass budget so no
// stage can silently blow past the hard ceiling. This is THE governor's teeth.