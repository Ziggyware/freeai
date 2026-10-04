/** PASS METER — the turn's governor.
 *
 *  Extracted from app.tsx because that file is at Val Town's 80,000-character-per-file ceiling and the
 *  only other way to make room is deleting comments, which is how the `https://` inside import strings
 *  got eaten and every request 502'd. This is the whole wall-clock/pass accounting for one turn: what a
 *  call may cost, when a call may not start, and the durable route/model event trail the timeline shows.
 */
import { T } from "./timing.ts";
import { type PromptKey, renderPrompt } from "./prompts.ts";
import { normalizeSettings, type Settings } from "./app-settings.ts";
import { callInference, type GenOpts, type InferResult } from "./app-infer.ts";
import { type ToolEvent } from "./app-helpers.ts";

export type Progress =
  | { type: "stage"; label: string }
  | { type: "tool"; hop: number; tool: string; args: Record<string, unknown>; result?: unknown; error?: string }
  | { type: "pass"; n: number; of: number; leftMs?: number }
  | { type: "thinking"; text: string }
  | { type: "continue"; n: number; chars?: number; tail?: string }
  | { type: "partial"; text: string }
  | { type: "retry"; n: number; error: string };

// Per-request user settings (from the UI's settings panel). Every field optional; defaults here.
// THE ONE PIECE OF ARITHMETIC THAT KEEPS A REQUEST INSIDE ITS INVOCATION.
//   val killed .................. 60 s
//   app-boundary.ts deadline .... 55 s  (returns 503 TURN_DEADLINE — an ERROR, so the client restarts the turn)
//   settings.budgetMs ........... 45 s  (app-settings.ts)
//   RETURN_RESERVE_MS ........... 10 s  never spent on inference: persistence, lint, JSON serialization
//   PER_CALL_MAX_MS ............. 20 s  ONE model call may never take longer, whatever the turn has left
//   MIN_CALL_MS .................  8 s  below this a call is not worth starting
// The failure this closes, from the trace: call 1 took 11 s, call 2 started with 38.5 s "left" and was given
// 35.5 s of it (timeLeft − 3 s), so a slow vendor could run to t=49 s; the request then still had to persist
// and serialize, hit 55 s, and died as an error. Restarting re-ran the build tool and produced a second
// artifact. With the caps below the last call that may START begins at t ≤ 27 s and ENDS by t ≤ 47 s,
// leaving ≥ 8 s of reserve inside a 55 s deadline — the turn always returns `truncated`, which the client
// already auto-continues and concatenates into the same bubble (main-script.ts willAuto/appendToLast).
export const RETURN_RESERVE_MS = T.returnReserve;
export const PER_CALL_MAX_MS = T.perCallMax;
export const MIN_CALL_MS = T.minCall;
/** Time a single model call may be given: never more than PER_CALL_MAX_MS, never into the return reserve. */
export const HOP_FLOOR_MS = MIN_CALL_MS + RETURN_RESERVE_MS; // a hop that cannot fund one call must not begin
export class PassMeter {
  private used = 0;
  private t0 = Date.now();
  public reasoning: string[] = [];
  // Durable half of the routing flowchart: one synthetic ToolEvent per model call that actually reached the
  // router with a trail (plan + attempts). cognize() splices this into the turn's real toolEvents before
  // returning, so it rides the exact same persistence path (message_meta.toolEvents) as every tool call —
  // one merged history, not a second parallel one that could drift or get dropped independently.
  public routeEvents: ToolEvent[] = [];
  // Every actual model call ("model call N/14" in the live timeline) was previously just that label —
  // `type:"pass"` carries no `.tool`, so ui-timeline.ts's row() returns a single unclickable line with no
  // expandable detail at all, unlike every tool call. This is the durable half of that call's own detail —
  // what was sent (model, message/system-prompt sizes, tool names, temperature/max_tokens) and what came
  // back (which provider actually answered, finish reason, content preview, token counts, latency) —
  // spliced into toolEvents the same way routeEvents is, so it's the same merged history, not a third list.
  public modelEvents: ToolEvent[] = [];
  constructor(
    private ceiling: number,
    public emit: (p: Progress) => void = () => {},
    public defaultModel: string | null = null,
    public settings: Settings = normalizeSettings({}),
    /** Absolute ms timestamp this meter must not outlive, when something OUTSIDE it owns the clock.
     *
     *  A scheduled step is exactly that case. scheduler.tick() claims a step with a lease of maxMs plus
     *  grace and hands the handler ctx.deadline, but the swarm's meters were constructed with only
     *  settings.budgetMs and a fresh t0 - so a builder claimed 25s into a 40s tick still believed it had
     *  a full 45s and would happily start a 20s call past the end of the tick AND past its own lease.
     *  The lease then lapsed, another isolate re-claimed the same step, and the work was done twice while
     *  the job made no progress. The meter must never outlive whatever actually owns the clock. */
    public hardDeadline: number | null = null,
  ) {}
  /** a prompt for this turn: user override or default, with {{vars}} filled */
  p(key: PromptKey, vars: Record<string, string> = {}): string {
    return renderPrompt(key, vars, this.settings.prompts, this.settings.examples);
  }
  /** ms of turn budget left; optional stages must check this before spending a pass */
  get timeLeft(): number {
    const own = this.settings.budgetMs - (Date.now() - this.t0);
    return this.hardDeadline ? Math.min(own, this.hardDeadline - Date.now()) : own;
  }
  get remaining(): number {
    return this.ceiling - this.used;
  }
  /** ms this ONE call may take. Bounded by PER_CALL_MAX_MS so a single slow vendor cannot consume the
   *  whole request, and by the return reserve so there is always time left to persist and answer. */
  get callBudget(): number {
    return Math.min(PER_CALL_MAX_MS, this.timeLeft - RETURN_RESERVE_MS);
  }
  async call(
    messages: unknown[],
    tools?: unknown[],
    model?: string | null,
    override: GenOpts = {},
  ): Promise<InferResult | null> {
    if (this.used >= this.ceiling) return null;
    // Checked BEFORE the pass is counted and announced. It used to be checked after `used++` and after the
    // "model call N/20" event, so a turn that had no time left still burned a pass and told the user a call
    // was starting that never started.
    if (this.callBudget < MIN_CALL_MS) {
      throw Object.assign(new Error(`TURN_BUDGET: ${Math.max(0, Math.round(this.timeLeft))}ms left, which cannot fund a ${MIN_CALL_MS}ms call plus the ${RETURN_RESERVE_MS}ms return reserve`), { budget: true });
    }
    this.used++;
    this.emit({ type: "pass", n: this.used, of: this.ceiling, leftMs: Math.round(this.timeLeft) });
    const s = this.settings;
    const expectFor = { short: 1200, long: 6000, max: 12_000 }[s.expect as "short" | "long" | "max"];
    const gen: GenOpts = { reasoning: s.reasoning, temperature: s.temperature, maxTokens: s.maxTokens, router: s.router, keyPolicy: s.keyPolicy, vendorOrder: s.vendorOrder, maxMode: s.expect === "max" && s.maxMode === "auto" ? "max" : s.maxMode, ...(expectFor ? { expect: expectFor } : {}), ...override };
    const req = this.summarizeRequest(messages, tools, model, gen);
    let r: InferResult;
    try {
      r = await callInference(messages, tools, model ?? this.defaultModel, this.callBudget, gen);
    } catch (e: any) {
      this.recordModelCall(req, null, e);
      throw e;
    }
    this.recordRoute(r);
    this.recordModelCall(req, r);
    if (r.reasoning) { this.reasoning.push(r.reasoning); this.emit({ type: "thinking", text: r.reasoning.slice(0, 600) }); }
    if (r.message?.content) this.emit({ type: "partial", text: String(r.message.content).slice(-1_500) });
    // Auto-continue: a reply cut at max_tokens is resumed in place (no tool calls, budget permitting).
    let n = 0;
    let lastLen = String(r.message?.content ?? "").length;
    // Same budget rule as a first call: a continuation segment that cannot be funded inside this request
    // is not started here — the reply comes back `truncated` and the CLIENT continues it in a fresh
    // invocation, appending into the same bubble. That is what "multiple requests, results concatenated"
    // means in practice: long output is split across invocations, never squeezed into one that dies.
    while (r.finishReason === "length" && !r.message?.tool_calls?.length && r.message?.content && n < s.continueMax && this.callBudget >= MIN_CALL_MS && this.used < this.ceiling) {
      n++; this.used++;
      this.emit({ type: "continue", n, chars: lastLen, tail: String(r.message.content).slice(-240) });
      const contReq = this.summarizeRequest([{ role: "user", content: this.p("continue") }], undefined, model, { ...gen, expect: 6000 }, `continue #${n} (${lastLen} chars so far)`);
      let cont: InferResult;
      try {
        cont = await callInference(
          [...messages, { role: "assistant", content: r.message.content }, { role: "user", content: this.p("continue") }],
          undefined, model ?? this.defaultModel, this.callBudget, { ...gen, expect: 6000 },
        );
      } catch (e) {
        this.recordModelCall(contReq, null, e as Error);
        this.emit({ type: "retry", n, error: `continuation failed, keeping ${r.message.content.length} chars: ${String((e as Error).message).slice(0, 120)}` });
        break; // keep the partial reply rather than failing the whole turn
      }
      this.recordRoute(cont);
      this.recordModelCall(contReq, cont);
      r = { ...cont, message: { ...r.message, content: r.message.content + (cont.message?.content ?? "") }, meta: { ...r.meta, retries: cont.meta.retries } };
      if (cont.reasoning) this.reasoning.push(cont.reasoning);
      this.emit({ type: "partial", text: String(r.message.content).slice(-1_500) });
      // progress guard: a continuation that adds < 200 chars is the cap being too small for this vendor, not a long reply — stop looping
      const nowLen = String(r.message.content).length; if (nowLen - lastLen < 200) { this.emit({ type: "retry", n, error: `continuation added ${nowLen - lastLen} chars — stopping in-turn continues; the client resumes next turn` }); break; } lastLen = nowLen;
    }
    return r;
  }
  get spent(): number {
    return this.used;
  }
  // One call may legitimately have no trail at all (e.g. it hit a custom gen.router.url the user configured,
  // which never goes through THIS val's router-core.ts) — silently skip rather than emit an empty node.
  private recordRoute(r: InferResult): void {
    const attempts = r.meta?.attempts;
    if (!attempts?.length) return;
    const winner = attempts[attempts.length - 1]?.ok ? attempts[attempts.length - 1].provider : null;
    const failed = attempts.filter((a) => !a.ok && !a.skipped).length;
    const error = winner ? undefined : `exhausted — ${failed} provider${failed === 1 ? "" : "s"} failed`;
    const args = { model: r.meta?.model ?? null, winner, tried: attempts.length, planned: (r.meta?.plan ?? attempts.map((a) => a.provider)).length };
    const result = { plan: r.meta?.plan ?? attempts.map((a) => a.provider), attempts, winner };
    this.routeEvents.push({ hop: -2, tool: "route", ts: Date.now(), args, result, error });
    // Reuses the SAME progress shape every other tool call already streams live (type:"tool"). Unlike other
    // tools, the route event DOES carry its result live: the live timeline is the one the user is actually
    // looking at mid-turn, and it was rendering "0 tried of 0 planned / []" under a header that said
    // "5/34 tried" — the flowchart body reads result, the header reads args. Bounded: attempts ≤ TRAIL_CAP
    // (60) with errors already truncated at the router, so this is a few KB per hop, not a file body.
    this.emit({ type: "tool", hop: -2, tool: "route", args, result, error });
  }
  // What the "model call N/14" step actually sent — not the routing candidates (that's recordRoute's
  // job), the shape of the REQUEST: which message actually prompted it, how much history/system prompt
  // rode along, which tools were offered, and the sampling knobs. Full message bodies are deliberately
  // left out (they're already visible as the preceding chat/tool turns) — this is a summary, not a dump.
  private summarizeRequest(messages: unknown[], tools: unknown[] | undefined, model: string | null | undefined, gen: GenOpts, label?: string): Record<string, unknown> {
    const arr = messages as any[];
    const last = [...arr].reverse().find((m) => m?.role === "user" || m?.role === "tool");
    const sys = arr.find((m) => m?.role === "system");
    return {
      label: label ?? null,
      model: model ?? this.defaultModel ?? "auto",
      messageCount: arr.length,
      lastMessage: last ? `[${last.role}] ${String(last.content ?? "").slice(0, 300)}` : null,
      systemPromptChars: sys ? String(sys.content ?? "").length : 0,
      tools: tools?.length ? tools.map((t: any) => t.function?.name ?? t.name ?? "?") : [],
      temperature: gen.temperature ?? null, maxTokens: gen.maxTokens ?? null, expect: gen.expect ?? null,
      reasoning: gen.reasoning ?? null, vendorOrder: gen.vendorOrder ?? null,
    };
  }
  // The response half. `error` (rather than a silent success) is set whenever the call itself threw
  // (budget exhaustion, total router exhaustion) OR it returned but with a non-terminal finish reason —
  // both are things a virtuoso reading the timeline would want flagged, not buried in "done".
  private recordModelCall(args: Record<string, unknown>, r: InferResult | null, err?: Error): void {
    if (!r) {
      const error = String(err?.message ?? err ?? "unknown error").slice(0, 300);
      this.modelEvents.push({ hop: -3, tool: "model", ts: Date.now(), args, error });
      this.emit({ type: "tool", hop: -3, tool: "model", args, error });
      return;
    }
    const toolCalls = (r.message?.tool_calls ?? []).map((c: any) => ({ name: c.function?.name ?? c.name, args: c.function?.arguments ?? c.args }));
    const result = {
      provider: r.meta?.instance ?? null, model: r.meta?.model ?? null,
      finishReason: r.finishReason ?? r.meta?.finishReason ?? null,
      content: r.message?.content ? String(r.message.content).slice(0, 1_500) : null,
      toolCalls, reasoningChars: r.reasoning ? r.reasoning.length : 0,
      tokensIn: r.meta?.tokensIn ?? r.usage?.prompt_tokens ?? null, tokensOut: r.meta?.tokensOut ?? r.usage?.completion_tokens ?? null,
      maxTokensSent: r.meta?.maxTokensSent ?? null, latencyMs: r.meta?.latencyMs ?? null, retries: r.meta?.retries ?? null,
    };
    const flagged = result.finishReason && !["stop", "tool_calls"].includes(result.finishReason);
    const error = flagged ? `finish_reason=${result.finishReason}` : undefined;
    this.modelEvents.push({ hop: -3, tool: "model", ts: Date.now(), args, result, error });
    this.emit({ type: "tool", hop: -3, tool: "model", args, result, error });
  }
}

/** Longest a SINGLE tool call may run. Model calls have been metered since this file existed; tool calls
 *  were not metered at all — `await tool.handle(args, ctx)` had no timeout of any kind. One hung MCP
 *  server, one slow libsql write, one web_search against an endpoint that never answers, and the request
 *  burned past the 55 s response deadline with the model budget still showing time left. The turn budget
 *  cannot see that time, so the tool has to be bounded on its own. */
export const TOOL_MAX_MS = T.toolMax;
/** ms this ONE tool call may take: never past the return reserve, never more than TOOL_MAX_MS, and never
 *  less than 2 s (a cheap tool finishing inside the reserve's slack beats failing it outright). */
export function toolBudget(timeLeftMs: number): number {
  return Math.max(2_000, Math.min(TOOL_MAX_MS, timeLeftMs - RETURN_RESERVE_MS));
}
/** Reject with a named, actionable error if `p` has not settled within `ms`. The tool's own promise is
 *  abandoned, not cancelled — JS cannot cancel it — so this bounds the REQUEST, not the work; the work
 *  may still complete in the background and its side effects still land. That is the honest description:
 *  a timeout here means "this turn stopped waiting", not "this did not happen". */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s and this turn stopped waiting for it; it may still be running. Do not call it again with the same arguments - either work without it or use a different approach.`), { toolTimeout: true })), ms);
    }),
  ]);
}
