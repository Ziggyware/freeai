import { PAGE_HTML } from "./main-html.tsx";
import { DEFAULT_PROMPTS, normalizePromptOverrides, PROMPT_VARS, type PromptKey, renderPrompt } from "./prompts.ts";
import { APP_RX, type ArtFile, deleteFile, extractHtmlDocument, lintArtifact, listFiles, qualityReport, readFile, saveArtifact, saveMany, serveFile, writeFile } from "./artifacts.ts";
import { discoverMcpTools } from "./mcp-client.ts";
import { clearSession, deleteSession, renameSession, type Tool, type ToolCtx, TOOLS } from "./app-tools.ts";
import { activeSkills, type Focus, normalizeSettings, type Settings, type Skill } from "./app-settings.ts";
import { handleSwarm } from "./app-swarm.ts";
import { clientStatusFor, installRejectionBackstop, RESPONSE_DEADLINE_MS, withBoundary } from "./app-boundary.ts";
import { maybeScheduleBuild, wireBuild } from "./app-build-wire.ts";
import { handleIssues, ISSUE_TOOLS } from "./issues.ts";
import { BUILD_RX, callInference, type GenOpts, type InferResult } from "./app-infer.ts";
import { compactMessage, handleCompact, liveChars, loadCompact } from "./app-compact.ts";
import { deriveTitle, evalJs, getMemoryBlob, META_CLOSE, META_OPEN, parseMeta, parseTextToolCalls, preEstimate, retrieveFacts, salvageArtifactArgs, summarizeEvent, slimEvents, TOOL_ALIASES, type ToolEvent, webSearch, writeFact, readJsonBody } from "./app-helpers.ts";
import {
  all,
  type Bound,
  type DbError,
  Err,
  initDB,
  insertMessageSafe,
  messagesFor,
  Ok,
  one,
  pruneSession,
  raw,
  type Result,
  type Row,
  run,
  sql,
  touchSession,
  unwrap,
} from "./db.ts";

// ════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

// Hop/pass budget governor caps. A single cheap query spends 1 inference pass;
// escalation spends from a bounded pool so "brilliant" never becomes "slow".
const BUDGET = {
  loopHops: 12, // max tool-hops inside agentLoop. The WALL CLOCK is the real governor - the turn hands
  // off to a fresh invocation when the budget runs out - so a low count only forced extra hand-offs.
  planPass: 1, // deliberation pass (mechanism 5)
  ensembleSamples: 3, // self-consistency fan-out on high-stakes (mechanism 6)
  verifyPass: 1, // adversarial self-refutation (mechanism 1)
  regroundPass: 1, // abstention→retrieval escalation (mechanism 2)
  hardCeilingPasses: 20, // absolute upper bound on inference calls per turn; time, not this number, normally binds
};

// Optional distinct model for the verifier so self-critique doesn't share the
// generator's exact blind spots. If the router ignores `model`, this is inert.
const VERIFIER_MODEL: string | null = null; // e.g. "different-model-id"

// ════════════════════════════════════════════════════════════════════════════
//  RATE LIMIT + SANITIZE
// ════════════════════════════════════════════════════════════════════════════
const recent = new Map<string, number>();
function rateLimit(k: string, ms = 900): boolean {
  const now = Date.now();
  if (now - (recent.get(k) ?? 0) < ms) return false;
  recent.set(k, now);
  return true;
}
function clean(s: string): string {
  return s.replace(/\u0000/g, "").trim().slice(0, 64_000);
}
async function safeJson(res: Response) {
  const ct = res.headers.get("content-type") || "";
  const body = await res.text(); // read once, as text
  if (!res.ok || !ct.includes("application/json")) {
    throw new Error(
      `Expected JSON, got ${res.status} ${ct}: ${body.slice(0, 120)}`,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Bad JSON: ${body.slice(0, 120)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  LEGACY BLOB MEMORY (kept for backward compat; no longer the ratchet path)
// ════════════════════════════════════════════════════════════════════════════
async function ensureSession(id: string): Promise<Row<"session">> {
  const existing = unwrap(
    await one("session", sql`SELECT * FROM session WHERE id = ${id}`),
    null,
  );
  if (existing) return existing;
  const row: Row<"session"> = { id, name: "New Chat", ts: Date.now() };
  await touchSession(row.id, row.name, row.ts);
  return row;
}

async function listSessions(): Promise<Row<"session">[]> {
  return unwrap(
    await all("session", sql`SELECT * FROM session ORDER BY ts DESC LIMIT 50`),
    [],
  );
}

// Deliberately does NOT reuse touchSession (which also bumps ts) — renaming
// a session shouldn't move it to the top of a recency-sorted list.

// ════════════════════════════════════════════════════════════════════════════
//  MESSAGE CRUD
// ════════════════════════════════════════════════════════════════════════════
async function addMsg(
  role: Row<"message">["role"],
  content: string,
  providerId: string | null = null,
  session = "default",
  meta: Record<string, unknown> | null = null,
): Promise<void> {
  const r = await insertMessageSafe({
    role,
    content,
    ts: Date.now(),
    session,
    providerId,
  });
  if (!r.ok) { console.error(`addMsg failed (session=${session}):`, r.error); return; }
  if (meta) {
    let json = JSON.stringify(meta);
    if (json.length > 120_000) json = JSON.stringify({ ...meta, toolEvents: slimEvents((meta.toolEvents as ToolEvent[]) ?? [], 200) });
    await run(sql`INSERT INTO message_meta (message_id, meta) VALUES (${r.value}, ${json}) ON CONFLICT(message_id) DO UPDATE SET meta = excluded.meta`);
  }
}

/** Newest messages that fit a character budget (≈ budget/3.6 tokens). Long single messages keep head + tail.
 *  The budget is what keeps prompts under free-tier input ceilings (Groq ITPM 7000 ≈ 25k chars all-in, of which
 *  system prompt + tool schemas already take ~10k); the router still skips vendors the prompt cannot fit. */
async function getContext(session = "default", limit = 24, budget = 16_000): Promise<Row<"message">[]> {
  const compact = await loadCompact(session);
  const rows = unwrap(await messagesFor(session, limit), []).filter((m) => !compact || m.id > compact.uptoId); // newest first; folded turns live in the summary
  const out: Row<"message">[] = []; let used = compact ? compact.chars : 0;
  for (const [i, m] of rows.entries()) {
    let content = m.content;
    if (content.length > 6_000) content = content.slice(0, 4_200) + "\n…[" + (content.length - 5_400) + " chars trimmed]…\n" + content.slice(-1_200);
    if (i >= 2 && used + content.length > budget) break; // always keep the last exchange
    used += content.length; out.push({ ...m, content });
  }
  out.reverse();
  if (compact) out.unshift({ id: 0, role: "system", content: compactMessage(compact).content, ts: compact.ts, session, providerId: null } as Row<"message">);
  return out;
}

async function getHistory(session: string): Promise<(Row<"message"> & { meta: unknown })[]> {
  const rows = unwrap(
    await raw<Row<"message"> & { meta: string | null }>(
      sql`SELECT m.*, mm.meta AS meta FROM message m LEFT JOIN message_meta mm ON mm.message_id = m.id WHERE m.session = ${session} ORDER BY m.id ASC`,
    ),
    [],
  );
  const out = rows.map((r) => { let meta: any = null; if (r.meta) { try { meta = JSON.parse(r.meta); } catch { /* ignore */ } } return { ...r, meta }; });
  // Backfill: assistant rows written before message_meta existed get synthetic create_artifact events for artifacts created in their window.
  if (out.some((m) => m.role === "assistant" && !m.meta)) {
    const arts = unwrap(await all("artifact", sql`SELECT id, title, kind, ts FROM artifact WHERE session = ${session} ORDER BY ts ASC`), []) as { id: number; title: string; kind: string; ts: number }[];
    let prevTs = 0;
    for (const m of out) {
      if (m.role === "assistant" && !m.meta) {
        const mine = arts.filter((a) => a.ts > prevTs && a.ts <= m.ts + 2_000);
        if (mine.length) m.meta = { backfilled: true, toolEvents: mine.map((a, i) => ({ hop: i, tool: "create_artifact", args: { title: a.title, kind: a.kind }, result: { ok: true, id: a.id, url: `/artifact/${a.id}/`, title: a.title } })) };
      }
      prevTs = m.ts;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  ARTIFACTS — small standalone apps (html/svg/markdown) the agent builds
//  in-chat. Identity is the numeric id, never (session, title) — a title match
//  is only a best-effort fallback lookup (see update_artifact's `title` param)
//  for when the id has been lost, not how "the same artifact" is determined.
//  Re-using a title never overwrites an unrelated artifact; within one turn,
//  ctx.turn.artifactId is what makes a second create_artifact call update the
//  first instead of creating a new row.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  TOOLS  (registry unchanged in spirit; memory tools now hit the fact store)
// ════════════════════════════════════════════════════════════════════════════

// Compose the per-request registry: built-ins win name collisions, because a
// remote MCP server must never be able to shadow memory/session primitives.
async function buildToolRegistry(): Promise<{
  tools: Record<string, Tool>;
  schemas: unknown[];
  mcpToolNames: string[];
}> {
  const mcp = await discoverMcpTools();
  console.log("discoverMCP: " + JSON.stringify(mcp));
  const tools: Record<string, Tool> = { ...mcp, ...TOOLS, ...ISSUE_TOOLS };
  return {
    tools,
    schemas: Object.values(tools).map((t) => t.schema),
    mcpToolNames: Object.keys(mcp).filter((k) => !(k in TOOLS)),
  };
}

import { HOP_FLOOR_MS, PassMeter, type Progress, toolBudget, withDeadline } from "./app-meter.ts";


// ════════════════════════════════════════════════════════════════════════════
//  META CONTROL CHANNEL
//  The final answer emits a trailing fenced block the USER never sees; the
//  governor parses it for {confidence, stakes, abstain}. Kept out of prose so
//  the visible reply stays clean.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
//  AGENT LOOP  (tool-agnostic; unchanged interface, threads the PassMeter)
// ════════════════════════════════════════════════════════════════════════════
interface AgentResult {
  reply: string;
  sessionName?: string;
  toolEvents: ToolEvent[];
  meta: InferResult["meta"];
  truncated?: boolean;
}
// Some open models (Qwen on Groq) emit tool calls as text instead of the
// structured field. Recover both shapes:
//   <tool_call>{"name":"x","arguments":{…}}</tool_call>
//   <tool_call><function=x><parameter=k>v</parameter>…</function></tool_call>
/** The JSON object starting at `at` (must be "{"), with nesting and string escapes respected; "" if unbalanced. */
export async function agentLoop(
  messages: unknown[],
  ctx: ToolCtx,
  meter: PassMeter,
): Promise<AgentResult> {
  const working = [...messages];
  const toolEvents: ToolEvent[] = [];
  const seen = new Map<string, unknown>(); // tool+args → result, for the repeat guard
  // The bug this closes: a model retrying the EXACT SAME failing call (classically update_artifact editing
  // a file that doesn't exist) with nothing forcing a change of approach. Each retry is a full model call —
  // up to HARD_TIMEOUT_MS(30s) of real network time — so from outside the app just sits there for tens of
  // seconds to minutes across hop after hop until BUDGET.loopHops/timeLeft finally cuts it off. The read-only
  // repeat guard just below only ever covered 4 tools and only ever handled IDENTICAL-success loops (a model
  // re-reading instead of acting); this is the general case — identical FAILURE loops, any tool.
  const failedSigs = new Map<string, string>(); // tool+args → last failure summary, for the stuck-loop guard
  let sessionName: string | undefined;
  let lastMeta: InferResult["meta"] = {};

  const exclude: string[] = []; let emptyRetries = 0;
  // Why the loop ended. The post-loop return below used to omit `truncated` entirely, so the two exits
  // that leave real work undone - running out of wall clock, and running out of hops while the model was
  // still calling tools - both reported a FINISHED turn. The client only auto-continues on `truncated`,
  // so the turn simply stopped mid-task and the user saw a partial answer with nothing continuing it.
  let unfinished = false;
  for (let hop = 0; hop < BUDGET.loopHops; hop++) {
    // 12_000 was below the floor a call actually needs, so a hop could start, immediately throw TURN_BUDGET,
    // and spend the difference proving it. HOP_FLOOR_MS is the same number the call gate uses.
    if (hop > 0 && meter.timeLeft < HOP_FLOOR_MS) { unfinished = true; break; }
    // Once an artifact exists the model only writes a short wrap-up; a small expectation lets slower vendors qualify.
    const built = toolEvents.some((e) => /artifact/.test(e.tool) && !e.error);
    let resp: InferResult | null;
    try {
      // After the first write, each further call is one file (≤ ~200 lines ≈ 3k tokens) or the wrap-up: a bounded expectation lets slower vendors qualify.
      resp = await meter.call(working, ctx.schemas, undefined, { ...(built ? { expect: 2500, maxTokens: Math.min(meter.settings.maxTokens ?? 3200, 3200) } : {}), ...(exclude.length ? { exclude } : {}) });
    } catch (e) {
      // Work already done by tools must not be lost to a failed wrap-up pass or an exhausted turn budget: report it, and mark the
      // turn truncated so the client continues in a fresh invocation instead of the val being killed mid-call.
      // A turn is NOT bound to one invocation - Val Town gives every HTTP request its own ~60s, and the
      // client continues a truncated turn in a fresh one. But that hand-off only happened when at least
      // one tool had already run: with no toolEvents this threw, the client saw an error instead of
      // `truncated: true`, and a turn whose FIRST model call exhausted the budget died outright instead
      // of resuming with a full clock. Budget and provider exhaustion are precisely the cases that a
      // fresh invocation fixes, so they hand off whether or not any tool got to run.
      const handoff = !!(e as any)?.budget || (e as any)?.status === 503;
      if (!toolEvents.length && !handoff) throw e;
      // Bug this closes: routeInference() (router-core.ts) throwing ALL_PROVIDERS_EXHAUSTED (status 503) or
      // NO_PROVIDERS_CONFIGURED mid-loop landed here same as any other error, but `budget` was ONLY ever set
      // by PassMeter.call()'s own `TURN_BUDGET` throw a few lines above (the wall-clock-left check) — a
      // completely different exhaustion. So a mid-turn provider exhaustion silently returned `truncated:
      // false`: the client (main-script.ts's `willAuto = final.truncated && ...`) never auto-continued, the
      // turn was accepted as a normal completed 200 OK with only a terse "Ran X. Ran Y." stub for a reply,
      // and the live per-turn timeline correctly wiped itself on what looked, to the client, like an
      // ordinary finish — the reported symptom ("the system just stops, the table disappears") end to end.
      // Router exhaustion is the SAME kind of "not lost, just needs a fresh invocation" situation the budget
      // path was already built for — status 503 (both ALL_PROVIDERS_EXHAUSTED and NO_PROVIDERS_CONFIGURED
      // set it) is the router's own signal for exactly that, so it now continues the same way.
      const budget = handoff;
      meter.emit({ type: "retry", n: 0, error: budget ? ((e as any)?.status === 503 ? "no provider available for this call right now — saving progress; continuing in the next turn" : "turn budget exhausted — saving progress; continuing in the next turn") : `wrap-up pass failed, reporting tool results: ${String((e as Error).message).slice(0, 120)}` });
      return { reply: toolEvents.map(summarizeEvent).filter(Boolean).join("\n\n"), sessionName, toolEvents, meta: lastMeta, truncated: budget };
    }
    if (!resp || !resp.message) break;
    const msg = resp.message;
    lastMeta = resp.meta;
    if (!msg.tool_calls?.length && typeof msg.content === "string" && /<tool_call>|to=functions\.|assistantfinal/.test(msg.content)) {
      const { calls, rest } = parseTextToolCalls(msg.content);
      if (calls.length) { msg.tool_calls = calls; msg.content = rest || null; resp.finishReason = "tool_calls"; }
      else msg.content = rest;
    }
    // Empty/garbage guard: no tool call and nothing visible (gpt-oss-20b "thinks" 30 tokens and stops). Never accept it —
    // retry on a different instance (router excludes the one that produced it), twice, before giving up.
    const visibleNow = typeof msg.content === "string" ? parseMeta(msg.content).visible.replace(/[\s…]+/g, "") : "";
    if (!msg.tool_calls?.length && visibleNow.length < 2 && emptyRetries < 2 && meter.timeLeft > HOP_FLOOR_MS && meter.remaining > 1) {
      emptyRetries++;
      const inst = String(resp.meta?.instance ?? (resp.meta?.provider as any)?.name ?? "");
      if (inst) exclude.push(inst);
      meter.emit({ type: "retry", n: emptyRetries, error: `empty reply from ${inst || "model"} — retrying on another vendor` });
      if (emptyRetries === 1) working.push({ role: "user", content: "Your previous reply was empty. Answer now: either call a tool (read_artifact / search_artifact / update_artifact) or write the answer. Do not reply with reasoning only." });
      hop--; continue;
    }

    working.push({
      role: "assistant",
      content: msg.content ?? null,
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    });

    const toolCalls: any[] = msg?.tool_calls ?? [];
    if (resp.finishReason === "stop" || !toolCalls.length) {
      let reply = (msg.content ?? "").trim();
      // "empty" must be judged on the VISIBLE part: a reply that is only the hidden META block is empty (qwen does this after a tool call)
      const visibleLen = (r: string) => parseMeta(r).visible.trim().length;
      const onlyMeta = reply && visibleLen(reply) === 0;
      if (onlyMeta) reply = "";
      // Placeholders left by this turn's writes: the turn is not finished. One nudge, then the lint issues ride along in the reply.
      const lastWrite = [...toolEvents].reverse().find((e) => (e.tool === "create_artifact" || e.tool === "update_artifact") && !e.error);
      const issuesLeft: string[] = ((lastWrite?.result as any)?.issues ?? []);
      const stubs = issuesLeft.filter((i) => /placeholder|stub|TODO marker|elided|fill-in|empty function|unimplemented|lorem/.test(i));
      const nudges = working.filter((m: any) => m.role === "user" && /^The artifact still (contains placeholders|has lint issues)/.test(String(m.content))).length;
      // Virtuoso gate: for app-scale asks the artifact must clear the quality report too (one nudge; the completion audit carries the rest across turns).
      const askText = String(([...working].reverse().find((m: any) => m.role === "user" && !/^The artifact (still|is below)/.test(String(m.content))) as any)?.content ?? "");
      const qualityLeft: string[] = APP_RX.test(askText) && BUILD_RX.test(askText) ? ((lastWrite?.result as any)?.quality ?? []) : [];
      const qNudges = working.filter((m: any) => m.role === "user" && /^The artifact is below the virtuoso standard/.test(String(m.content))).length;
      if (!issuesLeft.length && qualityLeft.length >= 3 && qNudges < 1 && hop < BUDGET.loopHops - 1 && meter.timeLeft > 24_000 && meter.remaining > 1) {
        meter.emit({ type: "stage", label: "raising quality" });
        working.push({ role: "user", content: `The artifact is below the virtuoso standard — a basic build is a failed build. Address every finding now with update_artifact (add real files and features; do not answer in prose first):\n${qualityLeft.slice(0, 12).join("\n")}` });
        continue;
      }
      // A turn does not end while the artifact it just wrote is broken (syntax, missing export, dangling ref) or stubbed. Two nudges max.
      if (issuesLeft.length && nudges < 2 && hop < BUDGET.loopHops - 1 && meter.timeLeft > 22_000 && meter.remaining > 1) {
        meter.emit({ type: "stage", label: stubs.length ? "replacing placeholders" : "fixing lint issues" });
        working.push({ role: "user", content: stubs.length
          ? `The artifact still contains placeholders — this is never acceptable. Replace each with the complete, working implementation via update_artifact now (do not remove the feature, do not answer in prose first):\n${stubs.slice(0, 8).join("\n")}`
          : `The artifact still has lint issues — fix every one with update_artifact now (batched edits; do not answer in prose first):\n${issuesLeft.slice(0, 10).join("\n")}` });
        continue;
      }
      const readOnly = toolEvents.some((e) => e.tool === "read_artifact") && !toolEvents.some((e) => e.tool === "update_artifact" || e.tool === "create_artifact");
      if (readOnly && hop < BUDGET.loopHops - 1 && meter.timeLeft > 22_000 && meter.remaining > 1 && !working.some((m: any) => m.role === "user" && String(m.content).startsWith("You read the artifact"))) {
        meter.emit({ type: "stage", label: "applying edit" });
        working.push({ role: "user", content: "You read the artifact but made no change. Call update_artifact now with the concrete edits (batched `edits` and/or `files`). Do not answer in prose until the tool has run." });
        continue;
      }
      if (!reply && toolEvents.length && meter.timeLeft > HOP_FLOOR_MS && meter.remaining > 0) {
        const onlyNaming = toolEvents.every((e) => e.tool === "name_session");
        meter.emit({ type: "stage", label: onlyNaming ? "answering" : "summarizing" });
        const again = await meter.call([...working, { role: "user", content: onlyNaming ? "Now answer the user's request in full. No tool calls." : meter.p("summarize") }]);
        reply = (again?.message?.content ?? "").trim();
        if (again?.meta) lastMeta = again.meta;
      }
      if (!reply && toolEvents.length) reply = toolEvents.map(summarizeEvent).filter(Boolean).join("\n\n");
      return {
        reply,
        sessionName,
        toolEvents,
        meta: lastMeta,
        truncated: resp.finishReason === "length",
      };
    }

    for (const tc of toolCalls) {
      let toolName: string = tc?.function?.name ?? "";
      let args: Record<string, unknown> = {};
      let salvaged: { saved: string[]; cut: string | null } | null = null;
      try {
        args = JSON.parse(tc?.function?.arguments ?? "{}");
      } catch (err) {
        // Arguments cut at max_tokens (finish_reason "length" with a tool call): keep every complete file, drop the cut one,
        // and tell the model exactly what to resend — one file per call. Progress is never thrown away.
        const sv = /artifact$/.test(toolName) || /artifact$/.test(TOOL_ALIASES[toolName] ?? "") ? salvageArtifactArgs(String(tc?.function?.arguments ?? "")) : null;
        if (sv) { args = sv.args; salvaged = { saved: sv.saved, cut: sv.cut }; meter.emit({ type: "retry", n: hop, error: `tool call cut at max_tokens — salvaged ${sv.saved.length} complete file(s)${sv.cut ? `, ${sv.cut} was cut` : ""}` }); }
        else { console.log("function argument error: " + String(err)); }
      }
      // aliases models reach for on their own
      if (!ctx.tools[toolName]) { const alias = TOOL_ALIASES[toolName]; if (alias && ctx.tools[alias]) toolName = alias; }

      const tool = ctx.tools[toolName];
      let output: unknown;
      let eventError: string | undefined;
      // Repeat guard: the same read twice in a turn returns the cached result plus a nudge — models that keep
      // re-reading instead of editing (gpt-oss, qwen) burn the whole budget otherwise.
      const sig = toolName + ":" + JSON.stringify(args);
      const seenBefore = seen.get(sig);
      if (tool && seenBefore && /^(read_artifact|search_artifact|memory_recall|web_search)$/.test(toolName)) {
        output = { ...(typeof seenBefore === "object" && seenBefore ? seenBefore as object : { result: seenBefore }), note: "IDENTICAL CALL REPEATED — you already have this result. Do not read again; call update_artifact with concrete edits now, or answer." };
        toolEvents.push({ hop, tool: toolName, args, result: { repeated: true }, ts: Date.now() });
        meter.emit({ type: "tool", hop, tool: toolName, args, error: "repeated" });
        working.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
        continue;
      }
      // Stuck-loop guard: this exact call already failed once, identically. Re-running it would fail the
      // same way again for the same reason — that's not progress, it's the spin. Short-circuit without
      // touching the DB/tool a second time, and name the prior failure explicitly so the model has to
      // change something rather than resend the same call on faith.
      const failedBefore = tool ? failedSigs.get(sig) : undefined;
      if (failedBefore) {
        output = { error: `REPEATED CALL, SAME ARGUMENTS AS A CALL THAT JUST FAILED: ${failedBefore}\nResending this exact call will fail the same way. Change your approach: fix what the error names, or do something else — do not call ${toolName} again with these exact arguments.` };
        eventError = failedBefore;
        toolEvents.push({ hop, tool: toolName, args, result: { repeated: true, priorFailure: failedBefore }, error: eventError, ts: Date.now() });
        meter.emit({ type: "tool", hop, tool: toolName, args, error: "repeated-failure" });
        working.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
        continue;
      }
      if (tool) {
        try {
          // BOUNDED. This was a bare `await tool.handle(...)` with no timeout, so a single unresponsive
          // tool could hold the request past the 55 s deadline while the model budget still read healthy.
          output = await withDeadline(tool.handle(args, ctx), toolBudget(meter.timeLeft), toolName);
          if (toolName === "name_session" && (output as any)?.name) {
            sessionName = (output as any).name;
          }
        } catch (e) {
          output = { error: String(e) };
          eventError = String(e);
        }
      } else {
        output = { error: `Unknown tool: ${toolName}. Available: ${Object.keys(ctx.tools).join(", ")}` };
        eventError = `Unknown tool: ${toolName}`;
      }
      if (!eventError) seen.set(sig, output);
      // A tool can fail "soft" — resolve without throwing but report failure in its own result shape
      // (update_artifact's `{ok:false, failed:[...]}`, e.g.) — eventError alone misses those.
      const softFailure = !eventError && output && typeof output === "object"
        ? (Array.isArray((output as any).failed) && (output as any).failed.length ? (output as any).failed.join("; ")
          : (output as any).ok === false ? "ok:false" : null)
        : null;
      if (eventError || softFailure) failedSigs.set(sig, String(eventError || softFailure).slice(0, 240));
      else failedSigs.delete(sig); // a later success for the same args clears any earlier failure
      if (salvaged && output && typeof output === "object") output = { ...(output as object), TRUNCATED_CALL: `Your tool call was cut at max_tokens. Saved complete files: [${salvaged.saved.join(", ") || "none"}]. ${salvaged.cut ? `"${salvaged.cut}" was cut and NOT saved.` : ""} Resend the missing file(s) now — ONE file per update_artifact call, ≤ ~200 lines each; keep calling until every file exists.` };

      toolEvents.push({
        hop,
        tool: toolName,
        args,
        result: eventError ? undefined : output,
        error: eventError,
        ts: Date.now(),
      });
      meter.emit({ type: "tool", hop, tool: toolName, args, error: eventError });
      working.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      });
    }
  }

  const last = [...working].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.trim()) as any;
  let reply = (last?.content ?? "").trim();
  if (!reply && toolEvents.length && meter.timeLeft > HOP_FLOOR_MS && meter.remaining > 0) {
    meter.emit({ type: "stage", label: "summarizing" });
    const again = await meter.call([...working, { role: "user", content: meter.p("summarize") }]).catch(() => null);
    reply = (again?.message?.content ?? "").trim();
  }
  if (!reply) reply = toolEvents.length ? toolEvents.map(summarizeEvent).filter(Boolean).join("\n\n") : "Agent loop limit reached.";
  // Falling out of the for-loop at all means the model never produced a tool-free final answer: either the
  // clock stopped it (unfinished) or it used every hop still calling tools. Both are unfinished turns.
  return { reply, sessionName, toolEvents, meta: lastMeta, truncated: unfinished || toolEvents.length > 0 };
}

// ════════════════════════════════════════════════════════════════════════════
//  INTELLIGENCE STAGES  (each gated by the governor; each spends from PassMeter)
// ════════════════════════════════════════════════════════════════════════════

// Mechanism 5 — deliberation: produce an explicit plan before acting.
async function planStage(
  base: unknown[],
  meter: PassMeter,
): Promise<string | null> {
  const resp = await meter.call([
    ...base,
    { role: "system", content: meter.p("plan") },
  ], undefined, undefined, { expect: 400, maxTokens: 800 });
  return resp?.message?.content ?? null;
}

// Self-consistency reconciles TEXT — it has no mechanism to reconcile side effects. Letting every
// resampled draft keep full tool access meant a high-stakes app-build request (maybeHighStakes fires
// on words like "production"/"deploy", which routinely co-occur with a build ask) could run
// create_artifact up to `samples` times independently: N real, fully-built, unrelated artifact rows,
// with the client's auto-open arbitrarily picking the first and the other N-1 orphaned — silent
// duplication with no relation to the reconciled reply the user actually reads. Fix: only the FIRST
// draft gets the real, mutating ctx; every resample after it gets a read-only view (below), so at most
// one artifact/memory-write/session-mutation can ever happen per turn, exactly like the non-ensemble path.
const ENSEMBLE_RESAMPLE_ALLOWED = new Set(["read_artifact", "search_artifact", "web_search", "memory_recall"]);
function readOnlyCtx(ctx: ToolCtx): ToolCtx {
  const tools = Object.fromEntries(Object.entries(ctx.tools).filter(([k]) => ENSEMBLE_RESAMPLE_ALLOWED.has(k)));
  const schemas = ctx.schemas.filter((s: any) => ENSEMBLE_RESAMPLE_ALLOWED.has(s?.function?.name));
  return { ...ctx, tools, schemas, turn: undefined }; // no turn to track: this view can't create/update an artifact
}

// Mechanism 6 — self-consistency: sample the answer path N times, reconcile.
async function ensembleStage(
  base: unknown[],
  ctx: ToolCtx,
  meter: PassMeter,
  samples: number,
): Promise<{ reconciled: string; drafts: string[]; toolEvents: ToolEvent[] }> {
  const drafts: string[] = [];
  const allEvents: ToolEvent[] = [];
  for (let i = 0; i < samples && meter.remaining > 2; i++) {
    const r = await agentLoop([...base], i === 0 ? ctx : readOnlyCtx(ctx), meter);
    drafts.push(r.reply);
    allEvents.push(...r.toolEvents);
  }
  if (drafts.length <= 1) {
    return { reconciled: drafts[0] ?? "", drafts, toolEvents: allEvents };
  }
  const resp = await meter.call([
    { role: "user", content: meter.p("reconcile", { drafts: drafts.map((d, i) => `DRAFT ${i + 1}:\n${d}`).join("\n\n") }) },
  ]);
  return {
    reconciled: resp?.message?.content ?? drafts[0],
    drafts,
    toolEvents: allEvents,
  };
}

// Mechanism 1 — adversarial verifier: self-refute, then revise if a flaw is found.
async function verifyStage(
  question: string,
  answer: string,
  meter: PassMeter,
): Promise<{ answer: string; verdict: string }> {
  const critique = await meter.call(
    [{ role: "user", content: meter.p("critique", { question, answer }) }],
    undefined,
    VERIFIER_MODEL,
    { expect: 200, maxTokens: 400 },
  );
  const verdict = (critique?.message?.content ?? "PASS").trim();
  if (/^PASS\b/i.test(verdict) || !/FLAW/i.test(verdict)) {
    return { answer, verdict: "PASS" };
  }
  const revised = await meter.call([
    { role: "user", content: meter.p("revise", { question, answer, flaw: verdict }) },
  ], undefined, undefined, { expect: Math.min(6000, Math.ceil(answer.length / 3) + 200) });
  const fixed = revised?.message?.content?.trim();
  return { answer: fixed && revised?.finishReason !== "length" ? fixed : answer, verdict }; // never replace a full answer with a cut one
}

// Mechanism 2 — abstention→reground: if the model abstains or is under-confident
// on a high-stakes ask, force a retrieval pass rather than let it confabulate.
async function regroundStage(
  base: unknown[],
  question: string,
  ctx: ToolCtx,
  meter: PassMeter,
): Promise<AgentResult> {
  return await agentLoop(
    [
      ...base,
      { role: "system", content: meter.p("reground", { question }) },
    ],
    ctx,
    meter,
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR — the cognition-budget governor wiring the stages together
// ════════════════════════════════════════════════════════════════════════════
interface Cognition {
  reply: string;
  sessionName?: string;
  toolEvents: ToolEvent[];
  meta: InferResult["meta"];
  reasoning: string[];
  truncated: boolean; // reply ended at max_tokens with no budget left to continue
  telemetry: {
    passesSpent: number;
    planned: boolean;
    ensembled: number;
    verifierVerdict: string;
    regrounded: boolean;
    confidence: number | null;
    stakes: string | null;
    abstained: boolean;
  };
}

async function cognize(
  input: string,
  base: unknown[],
  ctx: ToolCtx,
  isFirstExchange: boolean,
  emit: (p: Progress) => void = () => {},
  model: string | null = null,
  settings: Settings = normalizeSettings({}),
): Promise<Cognition> {
  const meter = new PassMeter(BUDGET.hardCeilingPasses, emit, model, settings);
  const { complex, maybeHighStakes } = preEstimate(input);

  const sys: any[] = [{ role: "system", content: meter.p("meta", { open: META_OPEN, close: META_CLOSE }) }];
  if (isFirstExchange) sys.push({ role: "system", content: meter.p("firstExchange") });
  const seed = [...base, ...sys];

  let planned = false;
  const lastUser = String(([...base].reverse().find((m: any) => m?.role === "user") as any)?.content ?? "");
  const appBuild = BUILD_RX.test(lastUser) && APP_RX.test(lastUser) && !settings.continuation && !settings.followup && !settings.focus;
  if (appBuild && settings.plan && meter.remaining > 6 && meter.timeLeft > 32_000) {
    // Design brief first: features (10–16), visual system, architecture, edge cases, acceptance — the single biggest lever
    // against "basic" output, because a model that has committed to 12 named features builds 12 features.
    meter.emit({ type: "stage", label: "design brief" });
    const brief = await meter.call([{ role: "system", content: "You are a principal engineer and product designer. Output only the brief." }, { role: "user", content: meter.p("brief", { ask: lastUser.slice(0, 4000) }) }], undefined, undefined, { expect: 1200, maxTokens: 1800, temperature: 0.4 })
      .then((r) => String(r?.message?.content ?? "").trim()).catch((e) => { meter.emit({ type: "retry", n: 0, error: `brief skipped: ${String(e?.message ?? e).slice(0, 160)}` }); return ""; });
    if (brief.length > 200) { seed.push({ role: "system", content: `DESIGN BRIEF (binding — implement every feature, file and acceptance check in it; the artifact is judged against it):\n${brief}` }); planned = true; }
  } else if (settings.plan && !settings.continuation && !settings.followup && complex && meter.remaining > 6 && meter.timeLeft > 32_000) {
    meter.emit({ type: "stage", label: "planning" });
    const plan = await planStage(seed, meter).catch((e) => { meter.emit({ type: "retry", n: 0, error: `plan skipped: ${String(e?.message ?? e).slice(0, 160)}` }); return null; });
    if (plan) {
      seed.push({ role: "system", content: `Plan to follow:\n${plan}` });
      planned = true;
    }
  }

  // Primary answer path — ensemble only when pre-estimate smells high-stakes AND
  // budget allows; otherwise a single loop pass.
  let reply: string;
  let sessionName: string | undefined;
  let toolEvents: ToolEvent[];
  let meta: InferResult["meta"];
  let ensembled = 0;
  let truncated = false;

  if (settings.ensemble && !settings.continuation && !settings.followup && maybeHighStakes && meter.remaining > BUDGET.ensembleSamples + 2 && meter.timeLeft > 30_000) {
    meter.emit({ type: "stage", label: "ensemble ×" + BUDGET.ensembleSamples });
    const e = await ensembleStage(seed, ctx, meter, BUDGET.ensembleSamples);
    reply = e.reconciled;
    toolEvents = e.toolEvents;
    ensembled = e.drafts.length;
    meta = {};
  } else {
    meter.emit({ type: "stage", label: "answering" });
    try {
      const r = await agentLoop(seed, ctx, meter);
      truncated = !!r.truncated;
      reply = r.reply;
      sessionName = r.sessionName;
      toolEvents = r.toolEvents;
      meta = r.meta;
    } catch (e: any) {
      // agentLoop only converts a budget-exhaustion into a graceful truncated result once a tool has
      // run (toolEvents.length > 0); at hop 0 — e.g. the design brief alone ate the wall clock — it
      // rethrows raw, which used to reach the HTTP handler as a flat 500 and discard everything paid
      // for so far. Surface it the same way agentLoop does for its own case: truncated:true (what the
      // client's auto-continue keys on) with whatever was already produced, persisted below via
      // addMsg("assistant", result.reply, ...) so the next continuation turn has it in context instead
      // of regenerating it into the same wall.
      if (!e?.budget) throw e;
      meter.emit({ type: "retry", n: 0, error: "turn budget exhausted before the first pass could run — saving progress; continuing in the next turn" });
      truncated = true;
      reply = planned ? String(seed.find((m: any) => typeof m.content === "string" && m.content.startsWith("DESIGN BRIEF"))?.content ?? "").replace(/^DESIGN BRIEF[^\n]*\n/, "") : "";
      sessionName = undefined;
      toolEvents = [];
      meta = {};
    }
  }

  // Parse the hidden meta channel.
  let { visible, meta: ansMeta } = parseMeta(reply);
  reply = visible;

  // The model wrote a whole HTML app into the reply instead of calling the tool: save it as an artifact anyway.
  if (!toolEvents.some((e) => e.tool === "create_artifact" && !e.error) && ctx.tools.create_artifact) {
    const doc = extractHtmlDocument(reply);
    if (doc) {
      const r = await saveArtifact(ctx.session, doc.title, "html", doc.html);
      if (r.ok) {
        toolEvents = [...toolEvents, { hop: -1, tool: "create_artifact", args: { title: r.value.title, kind: "html", auto: true }, result: { ok: true, id: r.value.id, url: `/artifact/${r.value.id}/`, title: r.value.title }, ts: Date.now() }];
        reply = reply.replace(/```(?:html|htm)?\s*\n[\s\S]*?\n```/i, `_Saved as artifact **${r.value.title}** — open it above._`);
      }
    }
  }

  // Mechanism 2 gate: abstain OR (high stakes AND low confidence) → reground.
  let regrounded = false;
  const lowConf = ansMeta ? ansMeta.confidence < 0.6 : false;
  const hiStakes = ansMeta ? ansMeta.stakes === "high" : maybeHighStakes;
  if ((ansMeta?.abstain || (hiStakes && lowConf)) && meter.remaining > 3 && meter.timeLeft > 22_000) {
    meter.emit({ type: "stage", label: "regrounding" });
    const rg = await regroundStage(base, input, ctx, meter).catch(() => null);
    if (rg) {
      const parsed = parseMeta(rg.reply);
      reply = parsed.visible || reply;
      ansMeta = parsed.meta ?? ansMeta;
      toolEvents = [...toolEvents, ...rg.toolEvents];
      regrounded = true;
    }
  }

  // Mechanism 1 gate: verify non-trivial answers when budget remains.
  let verifierVerdict = "SKIPPED";
  const nonTrivial = complex || hiStakes || toolEvents.length > 0;
  // Verification is skipped once an artifact was built: a 400-token critique cannot judge a 5k-token program, and the pass costs 10–20 s of a 52 s turn.
  const builtArtifact = toolEvents.some((e) => e.tool === "create_artifact" && !e.error);
  if (settings.verify && !settings.continuation && !truncated && !builtArtifact && nonTrivial && meter.remaining > 2 && reply.trim().length > 0 && meter.timeLeft > 22_000) {
    meter.emit({ type: "stage", label: "verifying" });
    const v = await verifyStage(input, reply, meter).catch((e) => { meter.emit({ type: "retry", n: 0, error: `verify skipped: ${String(e?.message ?? e).slice(0, 160)}` }); return { answer: reply, verdict: "ERROR" }; });
    reply = v.answer;
    verifierVerdict = v.verdict;
  }

  // Merge the routing flowchart's durable half into the turn's real toolEvents — ONE history, chronologically
  // interleaved (every event here now carries ts; stable sort preserves within-ts order, e.g. a route node
  // before the tool call its winning answer led to). This is the "one merged flowchart" the user asked for,
  // not a second parallel list ui-timeline.ts would have to reconcile against on its own.
  toolEvents = [...toolEvents, ...meter.routeEvents, ...meter.modelEvents].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return {
    reply,
    sessionName,
    toolEvents,
    meta,
    reasoning: meter.reasoning,
    truncated,
    telemetry: {
      passesSpent: meter.spent,
      planned,
      ensembled,
      verifierVerdict,
      regrounded,
      confidence: ansMeta?.confidence ?? null,
      stakes: ansMeta?.stakes ?? null,
      abstained: ansMeta?.abstain ?? false,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  CORE RUNTIME
// ════════════════════════════════════════════════════════════════════════════
/** Statuses this app owns, vs. statuses belonging to something upstream.
 *  app-infer.ts tags a failed router call with the UPSTREAM status, and mirroring that to the browser
 *  made a provider's 403 tier_not_allowed look like Val Town's own access gate - sending debugging in
 *  the wrong direction entirely. An upstream credential/permission failure is a GATEWAY failure: 502.
 *  Only 400 (caller's request was bad), 429 (we rate-limited them) and 503 (providers exhausted, retry
 *  is meaningful) pass through; 401/402/403/404 are OUR config problems, never a verdict about them. */
export { APP_OWNED_STATUSES, clientStatusFor } from "./app-boundary.ts";

/** The one implementation of "run a turn and report it over HTTP", shared by GET ?q= and POST ?q.
 *  Progress is PERSISTED, not in-memory: Val Town may serve the ?progress= poll from a different isolate
 *  than the one running the turn. Writes serialize through `chain`, and a progress write may never
 *  reject unhandled - telemetry must not fail the turn it describes. The `finally` emits "done" even on
 *  the error path, so a polling UI has a terminal event instead of polling forever. */
async function runTurn(q: string, session: string, settings: Settings, model: string | null): Promise<Response> {
  if (!q.trim()) return Response.json({ error: { message: "empty prompt" } }, { status: 400 });
  // A multi-file build becomes a step graph, not a 14-pass loop inside this one invocation.
  const scheduled = await maybeScheduleBuild(q, session, settings, { PassMeter, deriveTitle, clean, ensureSession, addMsg });
  if (scheduled) return Response.json(scheduled);
  const log: Progress[] = [];
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(() => run(sql`INSERT INTO progress (session, events, ts) VALUES (${session}, ${JSON.stringify(log)}, ${Date.now()})
        ON CONFLICT(session) DO UPDATE SET events = excluded.events, ts = excluded.ts`).then(() => {})).catch(() => {});
  };
  const emit = (p: Progress) => { log.push(p); persist(); };
  emit({ type: "stage", label: "starting" });
  try {
    const r = await runAI(q, session, emit, model, settings);
    await chain;
    return Response.json(r);
  } catch (err: any) {
    console.error("turn failed:", q.slice(0, 80), err);
    const msg = String(err?.message ?? err);
    const [head, ...rest] = msg.split("\n");
    return Response.json({ error: { message: head, details: rest } }, { status: clientStatusFor(err) });
  } finally {
    emit({ type: "stage", label: "done" });
    await chain.catch(() => {});
  }
}

async function runAI(
  input: string,
  session = "default",
  emit: (p: Progress) => void = () => {},
  model: string | null = null,
  settings: Settings = normalizeSettings({}),
) {
  if (!rateLimit(session)) {
    return { reply: "slow down", toolEvents: [], telemetry: null };
  }
  // The REQUEST's own clock. PassMeter governs the turn, but the digest split (before it) and the
  // completion audit (after it) are real model calls outside that accounting, with fixed timeouts of
  // their own - so the request could overrun the 55s response deadline even when the turn behaved
  // perfectly. Both now gate on what is actually left of the request.
  const requestT0 = Date.now();
  const requestLeft = () => RESPONSE_DEADLINE_MS - (Date.now() - requestT0);
  const text = clean(input);
  const sess = await ensureSession(session);
  const lastRow = settings.retryOf ? unwrap(await one("message", sql`SELECT * FROM message WHERE session = ${session} ORDER BY id DESC LIMIT 1`), null) : null;
  if (!(lastRow && lastRow.role === "user" && lastRow.content === text)) // a client retry after a 503: the ask is already stored
    await addMsg("user", text, null, session, settings.continuation ? { hidden: true, continuation: true } : settings.followup ? { hidden: true, followup: true } : null);
  await run(sql`UPDATE session SET ts = ${Date.now()} WHERE id = ${session}`); // recency: a turn moves the session up the list

  const blob = settings.memory ? await getMemoryBlob() : null; // legacy blob, if present
  const recalled = settings.memory ? await retrieveFacts(text) : []; // surprise-salience recall
  const context = await getContext(session, 24, settings.contextChars);
  const registry0 = await buildToolRegistry();
  const allow = settings.tools ? new Set(settings.tools) : null;
  const registry = allow
    ? { ...registry0, tools: Object.fromEntries(Object.entries(registry0.tools).filter(([k]) => allow.has(k) || k === "name_session")),
        schemas: Object.values(registry0.tools).filter((t: any) => allow.has(t.schema?.function?.name) || t.schema?.function?.name === "name_session").map((t: any) => t.schema) }
    : registry0;

  const memoryHeader = [
    blob?.value ? `blob:${blob.value}` : null,
    recalled.length ? `recalled:\n- ${recalled.join("\n- ")}` : null,
  ].filter(Boolean).join("\n\n") || "∅";

  // Advertise rojs only when discovery actually found it — a prompt promising
  // tools that aren't in the schema list just teaches the model to hallucinate
  // tool calls.
  const hasRojs = registry.mcpToolNames.some((n) => n.startsWith("rojs_"));
  const rojsHint = hasRojs
    ? `\n\nC#/Roslyn code-analysis tools (rojs_*) are connected via MCP. Workflow: rojs_create_session first (inline files[] or root_dir on the analysis host) — it returns a session_id every other rojs tool requires. Then: rojs_get_diagnostics (compile errors), rojs_hover, rojs_find_references, rojs_get_outline, rojs_context_bundle (token-budgeted context around a symbol — prefer it over pasting whole files), rojs_speculative_bind (check an expression compiles BEFORE proposing it), rojs_apply_edits with commit=false (dry-run diagnostic delta), rojs_rename_symbol. Sessions expire after idle timeout — recreate on NOT_FOUND. Positions are 0-based line/col.`
    : "";

  const toolNames = registry.schemas.map((t: any) => t?.function?.name).filter(Boolean).join(", ") || "none";
  const skillsOn = activeSkills(settings.skills, text);
  const ctx0HasArtifactTools = !!registry.tools.update_artifact;
  if (skillsOn.length) emit({ type: "stage", label: "skills: " + skillsOn.map((k) => k.name).join(", ") });
  const base = [
    {
      role: "system",
      content: renderPrompt("system", {
        date: new Date().toISOString().slice(0, 10),
        tools: toolNames,
        skills: skillsOn.length ? "\n" + skillsOn.map((k) => renderPrompt("skill", { name: k.name, body: k.body }, settings.prompts, settings.examples)).join("\n\n") + "\n" : "",
        focus: settings.focus && ctx0HasArtifactTools ? "\n" + renderPrompt("workbench", {
          id: String(settings.focus.id), title: settings.focus.title, files: settings.focus.files.join(", ") || "index.html", file: settings.focus.file || "index.html",
          selection: settings.focus.selection ? `\nSelected text in ${settings.focus.file}:\n\`\`\`\n${settings.focus.selection}\n\`\`\`` : "",
          errors: settings.focus.errors.length ? `\nConsole (latest first):\n${settings.focus.errors.slice().reverse().map((e) => "- " + e).join("\n")}` : "",
        }, settings.prompts, settings.examples) + "\n" : "",
        memory: memoryHeader === "∅" ? "" : `\nMemory (recalled facts about this user; trust as stated, do not repeat back):\n${memoryHeader}\n`,
        rojs: rojsHint ? `\n${rojsHint.trim()}\n` : "",
        user: settings.system ? `\nUser instructions (override the doctrine where they conflict):\n${settings.system}\n` : "",
      }, settings.prompts, settings.examples),
    },
    ...context.map(({ role, content }) => ({ role, content })),
  ];

  // COUNT(*) doesn't correspond to the message row shape, so it goes through
  // raw() rather than all("message", ...) — same honesty contract, just an
  // explicit generic instead of a table to pin it to.
  const msgCount = unwrap(
    await raw<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM message WHERE session = ${session}`,
    ),
    [],
  );
  const isFirstExchange = (msgCount[0]?.c ?? 0) <= 2;

  // Oversized ask (pasted logs, whole files): split across requests — parallel digests of each part, then the real
  // turn runs on the digests. This is what makes a 40k-char paste work on 7k-token free tiers.
  let turnText = text;
  if (text.length > 18_000 && !settings.continuation) {
    emit({ type: "stage", label: `splitting ${Math.ceil(text.length / 12_000)} parts` });
    const ask = text.slice(0, 400).replace(/\s+/g, " ");
    const parts: string[] = []; for (let i = 0; i < text.length && parts.length < 8; i += 12_000) parts.push(text.slice(i, i + 12_000));
    const digests = await Promise.all(parts.map((part, i) => callInference(
      [{ role: "system", content: "You compress source material for a later step. Output only the digest." }, { role: "user", content: renderPrompt("digest", { ask, part: String(i + 1), n: String(parts.length), text: part }, settings.prompts, settings.examples) }],
      // Same rule for the digest split: it runs BEFORE the turn, so whatever it spends is spent twice -
      // once here and again by the turn it is preparing for.
      undefined, "fast", Math.min(25_000, Math.max(8_000, requestLeft() - 25_000)), { expect: 900, maxTokens: 1_200, router: settings.router, keyPolicy: settings.keyPolicy, vendorOrder: settings.vendorOrder },
    ).then((r) => (r.message?.content ?? "").trim()).catch((e) => `[part ${i + 1} could not be digested: ${String(e.message).slice(0, 80)}]`)));
    turnText = `${text.slice(0, 1_500)}\n\n[The message was ${text.length} chars; it was split into ${parts.length} parts and digested. Work from these digests:]\n\n${digests.map((d, i) => `--- part ${i + 1}/${parts.length} ---\n${d}`).join("\n\n")}`;
    emit({ type: "stage", label: "digests ready" });
  }

  const result = await cognize(
    turnText,
    base,
    { session, tools: registry.tools, schemas: registry.schemas, turn: {} },
    isFirstExchange,
    emit,
    model,
    settings,
  );
  // Session title fallback: weaker models skip name_session, so derive one from the first user message.
  let sessionName = result.sessionName;
  if (!sessionName && !settings.continuation && (sess.name === "New Chat" || !sess.name)) {
    sessionName = deriveTitle(text);
    await renameSession(session, sessionName);
  }
  await addMsg("assistant", result.reply, null, session, {
    provider: result.meta?.provider ?? null, model: result.meta?.model ?? null, instance: result.meta?.instance ?? null, reasoning: result.reasoning ?? [], truncated: !!result.truncated,
    continuation: settings.continuation, followup: settings.followup, maxTokensSent: result.meta?.maxTokensSent ?? null, maxTokensAsked: result.meta?.maxTokensAsked ?? null, finishReason: result.meta?.finishReason ?? null, tokensOut: result.meta?.tokensOut ?? null,
    // attempts: how many providers the winning model call actually tried (main-script.ts's detail view already
    // had a slot for this — it was always empty since nothing populated it until router-core.ts's trail existed).
    attempts: result.meta?.attempts?.length ?? null,
    telemetry: result.telemetry ?? null, toolEvents: slimEvents(result.toolEvents ?? []), skills: skillsOn.map((k) => k.name),
  });
  // Completion audit: did this turn finish the ASK, or only its first pass? Cheap fast-tier call; the client
  // auto-continues with the remaining items until done (bounded by its autoComplete setting).
  let completion: { done: boolean; remaining: string[] } | null = null;
  const worked = (result.toolEvents ?? []).some((e) => /artifact|eval_js|rojs_/.test(e.tool));
  // The audit is a real 12s model call that runs AFTER the turn budget is already spent. Gated on the
  // request's remaining time, not on nothing: an audit that pushes the response past the deadline turns a
  // finished turn into a 503 and the client re-sends the whole thing.
  if (!settings.continuation && (worked || BUILD_RX.test(text)) && !result.truncated && requestLeft() > 15_000) {
    try {
      const did = (result.toolEvents ?? []).map((e) => `${e.tool}${e.error ? " (failed)" : ""}: ${JSON.stringify(e.args).slice(0, 160)}`).join("\n") || "(no tools)";
      const aid = [...(result.toolEvents ?? [])].reverse().map((e) => Number((e.result as any)?.id)).find((n) => Number.isInteger(n)) ?? Number(settings.focus?.id);
      let quality = "(no artifact this turn)";
      let lint: string[] = [];
      if (Number.isInteger(aid) && APP_RX.test(text)) { const lf = await listFiles(aid); if (lf) { lint = lintArtifact(lf.files); const q = qualityReport(lf.files); quality = (lint.length ? `LINT (must fix):\n` + lint.map((x) => "- " + x).join("\n") + "\n" : "") + (q.length ? `polish notes:\n` + q.map((x) => "- " + x).join("\n") : `artifact #${aid} clears the rubric`); } }
      const r = await callInference(
        [{ role: "system", content: "You audit whether a task is finished. Output only JSON." }, { role: "user", content: renderPrompt("completion", { ask: text.slice(0, 3000), did, reply: (result.reply ?? "").slice(0, 3000), quality }, settings.prompts, settings.examples) }],
        undefined, "fast", Math.min(12_000, requestLeft() - 4_000), { expect: 300, maxTokens: 500, router: settings.router, keyPolicy: settings.keyPolicy, vendorOrder: settings.vendorOrder },
      );
      const raw = String(r.message?.content ?? ""); const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const remaining = Array.isArray(j.remaining) ? j.remaining.filter((x: unknown) => typeof x === "string").slice(0, 8) : [];
      // Lint errors are remaining work. Quality/polish scores are not — forcing another turn for
      // "add 900 lines" is how a working app became a broken one.
      if (lint.length) remaining.unshift(...lint.slice(0, 4));
      completion = { done: lint.length === 0 && j.done !== false && remaining.length === 0, remaining: remaining.slice(0, 8) };
      if (completion.remaining.length === 0) completion.done = true;
    } catch { completion = null; }
  }
  // Compaction hint: when the live (unfolded) history exceeds twice the context budget, the client runs POST ?compact
  // as its own invocation after this reply lands — never inside the turn's 60 s.
  let needsCompact = false;
  try { const c = await loadCompact(session); const live = await liveChars(session, c?.uptoId ?? 0); needsCompact = live.count > 8 && live.chars > 2 * settings.contextChars; } catch { /* hint only */ }
  return {
    reply: result.reply,
    sessionName,
    toolEvents: result.toolEvents,
    meta: result.meta,
    reasoning: result.reasoning,
    truncated: result.truncated,
    telemetry: result.telemetry,
    completion,
    needsCompact,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  HTTP HANDLER  (branch style preserved; +telemetry surfaced on the q path)
// ════════════════════════════════════════════════════════════════════════════
/** Val Town kills an invocation at ~60s. A killed isolate writes NOTHING, so Cloudflare serves its own
 *  "Bad gateway" page - a failure that cannot be diagnosed from inside, since nothing inside survived.
 *  Every subsystem here already has a budget, but those guarantee each PART finishes, not that the WHOLE
 *  responds; anything unbudgeted (a slow DB batch, an MCP call, a step added later) reintroduces the 502.
 *  So the invariant is enforced once, at the boundary: this handler ALWAYS answers before the kill.
 *  Racing is crude - losing work is abandoned when the isolate dies - but progress is persisted as it
 *  goes, so the client can poll ?progress= or recover the reply from history. */
export { RESPONSE_DEADLINE_MS } from "./app-boundary.ts";

installRejectionBackstop();
export default withBoundary(handleRequest, {
  label: "TURN",
  details: ["Work already completed was saved - poll ?progress=<session> or reload the session history before retrying."],
});

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const init = await initDB();
  if (!init.ok) {
    return new Response(`DB init failed: ${init.error}`, { status: 500 });
  }

  // /artifact/<id>/<path> — multi-file artifacts served path-style so relative references resolve
  const am = url.pathname.match(/^\/artifact\/(\d+)(?:\/(.*))?$/);
  if (am) {
    const id = Number(am[1]);
    if (am[2] === undefined) return new Response(null, { status: 302, headers: { Location: `/artifact/${id}/` } });
    if (method === "GET") {
      const f = await readFile(id, am[2] || "");
      if (!f) return new Response("not found", { status: 404 });
      const path = am[2] || (f.kind === "html" ? "index.html" : f.kind === "svg" ? "index.svg" : "index.md");
      return serveFile(url.origin, path, f.content);
    }
  }
  const compacted = await handleCompact(req, url, (messages, settings) => callInference(messages, undefined, "fast", 45_000, { expect: 1400, maxTokens: 2000, temperature: 0.2, router: settings.router, keyPolicy: settings.keyPolicy, vendorOrder: settings.vendorOrder }).then((r) => String(r.message?.content ?? "")));
  if (compacted) return compacted;
  if (method === "GET" && url.searchParams.has("artifact_files")) {
    const r = await listFiles(Number(url.searchParams.get("artifact_files")));
    if (!r) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ id: r.artifact.id, title: r.artifact.title, kind: r.artifact.kind, session: r.artifact.session, files: r.files, issues: lintArtifact(r.files) });
  }
  wireBuild({ PassMeter, deriveTitle, clean, ensureSession });
  const swarm = await handleSwarm(req, url, { PassMeter, deriveTitle, clean, ensureSession });
  if (swarm) return swarm;
  const issuesRes = await handleIssues(req, url);
  if (issuesRes) return issuesRes;
  if (method === "POST" && url.searchParams.has("artifact_save_many")) {
    const b = await readJsonBody(req);
    const id = Number.isInteger(b.id) ? b.id : null;
    if (id) { const a = await listFiles(id); if (!a) return Response.json({ error: "not found" }, { status: 404 }); }
    const r = await saveMany(String(b.session ?? "default"), id, String(b.title ?? ""), Array.isArray(b.files) ? b.files : []);
    return r ? Response.json({ ok: true, ...r, url: `/artifact/${r.id}/` }) : Response.json({ error: "save failed" }, { status: 500 });
  }
  if (method === "POST" && url.searchParams.has("artifact_delete_file")) {
    const b = await readJsonBody(req);
    const w = await deleteFile(Number(b.id), String(b.path ?? ""), b.dir === true);
    return w.ok ? Response.json({ ok: true }) : Response.json({ error: "cannot delete" }, { status: 400 });
  }
  if (method === "POST" && url.searchParams.has("artifact_save")) {
    const b = await readJsonBody(req);
    const id = Number(b.id), path = String(b.path ?? ""), content = typeof b.content === "string" ? b.content : null;
    if (!id || !path || content === null) return Response.json({ error: "id, path, content required" }, { status: 400 });
    const w = await writeFile(id, path, content);
    return w.ok ? Response.json({ ok: true, url: `/artifact/${id}/` }) : Response.json({ error: w.error }, { status: 500 });
  }

  if (
    method === "GET" &&
    !url.searchParams.has("q") &&
    !url.searchParams.has("sessions") &&
    !url.searchParams.has("session") &&
    !url.searchParams.has("history") &&
    !url.searchParams.has("artifact") &&
    !url.searchParams.has("progress") &&
    !url.searchParams.has("prompts")
  ) {
    return new Response(PAGE_HTML, {
      headers: { "content-type": "text/html" },
    });
  }

  if (method === "GET" && url.searchParams.has("sessions")) {
    return Response.json(await listSessions());
  }

  if (method === "GET" && url.searchParams.has("history")) {
    return Response.json(await getHistory(url.searchParams.get("history")!));
  }

  if (method === "GET" && url.searchParams.has("artifacts")) {
    const session = url.searchParams.get("session") ?? "default";
    const rows = unwrap(
      await all(
        "artifact",
        sql`SELECT * FROM artifact WHERE session = ${session} ORDER BY ts DESC`,
      ),
      [],
    );
    return Response.json(
      rows.map(({ id, title, kind, ts }) => ({ id, title, kind, ts })),
    );
  }

  if (method === "GET" && url.searchParams.has("artifact")) {
    const id = Number(url.searchParams.get("artifact"));
    if (!Number.isInteger(id)) return new Response("bad id", { status: 400 });
    return new Response(null, { status: 302, headers: { Location: `/artifact/${id}/` } });
  }

  if (method === "GET" && url.searchParams.has("q")) {
    // GET and POST run the SAME turn through runTurn(). They used to be two hand-maintained copies, and
    // they had drifted in four ways that all surface as "the status update is broken":
    //   - GET passed `emit = undefined`, so a GET-started turn persisted NO progress rows at all and a
    //     subsequent ?progress= poll returned {events: [], next: 0} forever — indistinguishable from a
    //     hung turn, which is exactly what it looks like from the UI;
    //   - GET skipped POST's `if (!q.trim())` guard, so a bare `?q` (value "") ran a turn on empty input;
    //   - GET ignored settings entirely, so model/router/vendor preferences silently did not apply;
    //   - GET returned `{error: "<string>"}` while POST returns `{error: {message, details}}`, so any
    //     caller reading `error.message` got undefined on one path and a message on the other.
    // One code path removes the possibility of a fifth divergence rather than fixing these four.
    return runTurn(
      url.searchParams.get("q") ?? "",
      url.searchParams.get("session") ?? "default",
      normalizeSettings({ model: url.searchParams.get("model") ?? undefined }),
      url.searchParams.get("model"),
    );
  }

  // POST {q, session, model} → JSON result. Progress is NOT streamed: Val Town
  // terminates a streamed body ~10 s after headers go out (observed 11.0 s ×3,
  // keepalives don't help), so the turn runs to completion here while the UI
  // polls ?progress=<session>&since=<n> against the in-memory event log.
  if (method === "POST" && url.searchParams.has("q")) {
    const body = await readJsonBody(req);
    const q = String(body.q ?? "");
    const settings = normalizeSettings({ ...(body.settings ?? {}), model: body.settings?.model ?? body.model });
    // App-scale builds default to the coder tier (openrouter/hf/mistral/zai/dashscope coder-tagged models); groq's small models produce "basic" apps.
    const model = settings.model ?? (BUILD_RX.test(q) && APP_RX.test(q) && !body.settings?.continuation ? "coder" : null);
    return runTurn(q, String(body.session ?? "default"), settings, model);
  }

  if (method === "GET" && url.searchParams.has("prompts")) {
    return Response.json({ defaults: DEFAULT_PROMPTS, vars: PROMPT_VARS });
  }

  if (method === "GET" && url.searchParams.has("progress")) {
    const r = await one<"progress">("progress", sql`SELECT * FROM progress WHERE session = ${url.searchParams.get("progress")!}`);
    const events: Progress[] = r.ok && r.value ? JSON.parse(r.value.events) : [];
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    return Response.json({ events: events.slice(since), next: events.length });
  }

  if (method === "POST" && url.searchParams.has("rename")) {
    const { id, name } = await readJsonBody(req);
    await renameSession(id, name);
    return Response.json({ ok: true });
  }

  if (method === "POST" && url.searchParams.has("clear")) {
    const { id } = await readJsonBody(req);
    await clearSession(id);
    return Response.json({ ok: true });
  }

  if (method === "DELETE" && url.searchParams.has("session")) {
    // Answering {ok:true} unconditionally is what hid a failing delete: the row survived, the sidebar
    // re-rendered it, and the click looked like it did nothing.
    const d = await deleteSession(url.searchParams.get("session")!);
    return d.ok ? Response.json({ ok: true }) : Response.json({ error: { message: d.error } }, { status: 500 });
  }

  return new Response("not found", { status: 404 });
}