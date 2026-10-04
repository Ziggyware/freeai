// Per-request settings: shape, validation and the skill matcher. Split out of app.tsx
// to keep each file under Val Town's 80 kB file-API limit.
import { T } from "./timing.ts";
import { normalizePromptOverrides, type PromptKey } from "./prompts.ts";
export interface Settings {
  model: string | null; // router alias/pin; null = auto
  reasoning: "low" | "medium" | "high" | null;
  temperature: number | null;
  maxTokens: number | null; // null = size to task (respecting vendor limits); number = hard preference
  system: string; // custom instructions appended to the system prompt
  tools: string[] | null; // enabled tool names; null = all
  plan: boolean; verify: boolean; ensemble: boolean; memory: boolean;
  continueMax: number; // auto-continue passes when a reply is cut at max_tokens
  budgetMs: number; // wall-clock budget for the turn (free plan hard cap is 60 s)
  prompts: Partial<Record<PromptKey, string>>; // per-prompt overrides; see prompts.ts
  examples: boolean; // append the two exemplars per prompt (prompt-examples.ts); off saves ~1–3k input tokens per call
  focus: Focus | null; // artifact the workbench has open when the message was sent
  skills: Skill[]; // user-defined instruction packs; `always` or keyword-triggered `auto`
  router: { url: string; key: string | null } | null; // inference router override (allowlisted hosts only)
  maxMode: "auto" | "fixed" | "max"; // auto = size to task; fixed = maxTokens; max = ask for the vendor ceiling
  continuation: boolean; // this turn resumes a reply cut at the output limit: skip plan/verify/ensemble, hide the user turn
  expect: "auto" | "short" | "long" | "max"; // expected reply length → omni_expect_tokens and max_tokens sizing
  keyPolicy: "depth" | "rr" | "breadth" | null; // router key rotation for this request (null = router default)
  contextChars: number; // history budget sent to the model (chars); small keeps free-tier ITPM limits reachable
  retryOf: boolean; // client re-sent the same ask after a 503: do not insert the user message again
  vendorOrder: string[]; // vendors to try first, in order (every key slot of one before the next); [] = router default
  followup: boolean; // auto-continuation of unfinished work (client-issued): hide the synthetic user turn, skip plan/ensemble
}
const ROUTER_ALLOW = (Deno.env.get("OMNI_ROUTER_ALLOW") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export function normalizeRouter(x: any): Settings["router"] {
  if (!x || typeof x !== "object" || typeof x.url !== "string") return null;
  try {
    const u = new URL(x.url);
    if (u.protocol !== "https:" || !(u.hostname.endsWith(".val.run") || ROUTER_ALLOW.includes(u.hostname))) return null;
    return { url: u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")), key: typeof x.key === "string" && x.key ? x.key.slice(0, 200) : null };
  } catch { return null; }
}
export interface Focus { id: number; title: string; file: string; files: string[]; selection: string; errors: string[] }
export interface Skill { name: string; when: string; body: string; mode: "always" | "auto" }
export function normalizeFocus(x: any): Focus | null {
  if (!x || typeof x !== "object" || !Number.isInteger(x.id)) return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return { id: x.id, title: str(x.title, 120), file: str(x.file, 200), files: Array.isArray(x.files) ? x.files.filter((f: unknown) => typeof f === "string").slice(0, 40) : [],
    selection: str(x.selection, 4000), errors: Array.isArray(x.errors) ? x.errors.filter((e: unknown) => typeof e === "string").slice(-8).map((e: string) => e.slice(0, 400)) : [] };
}
export function normalizeSkills(x: any): Skill[] {
  if (!Array.isArray(x)) return [];
  return x.filter((k) => k && typeof k === "object" && typeof k.name === "string" && typeof k.body === "string" && k.body.trim())
    .slice(0, 12).map((k) => ({ name: k.name.slice(0, 60), when: typeof k.when === "string" ? k.when.slice(0, 300) : "", body: k.body.slice(0, 6000), mode: k.mode === "always" ? "always" : "auto" }));
}
/** Skills that apply to this message: `always`, or `auto` whose `when` (comma/pipe-separated keywords or /regex/) matches the text. */
export function activeSkills(skills: Skill[], text: string): Skill[] {
  const t = text.toLowerCase();
  return skills.filter((k) => {
    if (k.mode === "always") return true;
    const w = k.when.trim(); if (!w) return false;
    const m = w.match(/^\/(.+)\/([a-z]*)$/);
    if (m) { try { return new RegExp(m[1], m[2].replace(/g/g, "") || "i").test(text); } catch { return false; } }
    return w.split(/[,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean).some((kw) => t.includes(kw));
  });
}
export function normalizeSettings(x: any): Settings {
  const num = (v: unknown, lo: number, hi: number, d: number | null) => (typeof v === "number" && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    model: typeof x?.model === "string" && x.model && x.model !== "auto" ? x.model : null,
    reasoning: ["low", "medium", "high"].includes(x?.reasoning) ? x.reasoning : null,
    temperature: num(x?.temperature, 0, 2, null),
    maxTokens: num(x?.maxTokens, 256, 65_536, null),
    system: typeof x?.system === "string" ? x.system.slice(0, 8000) : "",
    tools: Array.isArray(x?.tools) ? x.tools.filter((t: unknown) => typeof t === "string") : null,
    plan: x?.plan !== false, verify: x?.verify !== false, ensemble: x?.ensemble !== false, memory: x?.memory !== false,
    continueMax: num(x?.continueMax, 0, 8, 3) as number,
    // 45 s, not 52 s. The val is killed at 60 s and app-boundary.ts ends the response at 55 s; a 52 s turn
    // budget left nothing between the last model call and that deadline, so a turn that used its budget was
    // killed as a 503 TURN_DEADLINE instead of returning what it had. The client then RE-SENT the original
    // message and re-ran every tool from scratch. 45 s − RETURN_RESERVE_MS(10 s) is the real working window;
    // the remainder pays for persistence, lint and serialization. See PER_CALL_MAX_MS in app.tsx.
    // The FLOOR is 20 s, not 15 s: app-meter.ts will not start a model call unless the turn still has
    // MIN_CALL_MS + RETURN_RESERVE_MS = 18 s left, so a 15 s budget produced a turn that could never make
    // a single call — every request would throw TURN_BUDGET at hop 0 and answer nothing.
    budgetMs: num(x?.budgetMs, T.minCall + T.returnReserve + 2_000, T.chatTurnBudget, T.chatTurnBudget) as number,
    prompts: normalizePromptOverrides(x?.prompts),
    examples: x?.examples !== false,
    focus: normalizeFocus(x?.focus),
    skills: normalizeSkills(x?.skills),
    router: normalizeRouter(x?.router),
    maxMode: x?.maxMode === "fixed" ? "fixed" : x?.maxMode === "max" ? "max" : "auto",
    continuation: x?.continuation === true,
    expect: ["short", "long", "max"].includes(x?.expect) ? x.expect : "auto",
    keyPolicy: ["depth", "rr", "breadth"].includes(x?.keyPolicy) ? x.keyPolicy : null,
    contextChars: num(x?.contextChars, 2_000, 120_000, 16_000) as number,
    retryOf: x?.retryOf === true,
    followup: x?.followup === true,
    vendorOrder: typeof x?.vendorOrder === "string" ? x.vendorOrder.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean).slice(0, 12) : [],
  };
}
