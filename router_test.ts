// Runtime tests for the provider catalog and the routing engine: which providers
// a request reaches, in what order, and what happens when they fail.
//
//   deno test --allow-env --allow-net --allow-read router_test.ts
//
// Self-contained on purpose. timing_test.ts rolls its own assertEqual rather than
// pulling in std, and this file follows suit: a test that needs an import map to
// run is a test that does not get run. The only external dependency is `fetch`,
// which every scenario replaces with a recorder — these tests assert routing
// decisions, not vendor behaviour, and a suite that needed real API keys would
// fail for reasons that have nothing to do with the router.
import { bumpProviderStats } from "./db.ts";
import {
  capInFor, cooldownInfo, discoverModel, getInstanceRoster, inflight,
  invalidateState, isCooling, loadState, MAX_CONCURRENCY, rankCandidates,
  resetCooldowns, resetProviderStats, routeChat, stateView, type RankCtx,
} from "./router.ts";
import {
  catalogStatus, clampMaxTokens, estimateTokens, etaMs, instances, keyIssue,
  knownModelValues, promptFits, quality, resetRoster, resolveTargets, splitKeys,
  vendorsOf,
} from "./providers.ts";
import { chatCompletions, chatCompletionsResponse, clearModelsCache, routerRoutes } from "./router-api.ts";

// ── asserts ──────────────────────────────────────────────────────────────────
const show = (v: unknown): string => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const assert = {
  equal(a: unknown, b: unknown, m = ""): void { if (a !== b) throw new Error(`${m ? m + ": " : ""}expected ${show(b)}, got ${show(a)}`); },
  notEqual(a: unknown, b: unknown, m = ""): void { if (a === b) throw new Error(`${m ? m + ": " : ""}expected not ${show(b)}`); },
  deepEqual(a: unknown, b: unknown, m = ""): void { if (show(a) !== show(b)) throw new Error(`${m ? m + ": " : ""}expected ${show(b)}, got ${show(a)}`); },
  ok(v: unknown, m = ""): void { if (!v) throw new Error(m || `expected truthy, got ${show(v)}`); },
  match(s: string, re: RegExp, m = ""): void { if (!re.test(s ?? "")) throw new Error(`${m ? m + ": " : ""}${show(s)} did not match ${re}`); },
  async rejects(fn: () => Promise<unknown>, check: (e: any) => boolean, m = ""): Promise<void> {
    try { await fn(); } catch (e: any) { if (!check(e)) throw new Error(`${m ? m + ": " : ""}rejection did not satisfy the check: ${String(e?.message ?? e).slice(0, 300)}`); return; }
    throw new Error(`${m ? m + ": " : ""}expected a rejection, but the call succeeded`);
  },
};

// ── env ──────────────────────────────────────────────────────────────────────
// Deno.env is the real thing under `deno test`; a Map stands in elsewhere. Keys
// this file sets are tracked and removed individually — never Deno.env.clear(),
// which would take the database credentials down with it.
type EnvLike = { get(k: string): string | undefined; set(k: string, v: string): void; delete?(k: string): void };
const ENV: EnvLike = (globalThis as any).Deno?.env ??
  (() => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k) }; })();
let envTouched = new Set<string>();
/** Every env write in this file goes through here, including the ones a scenario
 *  makes part-way through rather than in its reset() call. An untracked write
 *  leaks: OMNI_ADMIN_KEY set by the auth scenario was still gating the matrix-UI
 *  scenario three tests later, which failed with a 401 that had nothing to do with
 *  what it was testing. */
const setEnv = (k: string, v: string): void => { envTouched.add(k); ENV.set(k, v); };
const unsetEnv = (k: string): void => { try { ENV.delete ? ENV.delete(k) : ENV.set(k, ""); } catch { ENV.set(k, ""); } };

// ── scenario isolation ───────────────────────────────────────────────────────
/** A clean world: no leftover env, roster, cooldowns, learned ceilings, model
 *  caches or usage counters carried in from the scenario before this one.
 *  Everything is cleared through the router's own public resets, so the suite
 *  behaves identically against a real database and against a stub. */
async function reset(env: Record<string, string> = {}) {
  for (const k of envTouched) unsetEnv(k);
  envTouched = new Set();
  for (const [k, v] of Object.entries(env)) setEnv(k, v);
  resetRoster();
  invalidateState();
  clearModelsCache();
  await resetProviderStats();
  await resetCooldowns();
  // Forced, so the reload REPLACES rather than merges: an ordinary TTL refresh
  // keeps whichever cooldown expires later, which is right in production (many
  // isolates, one database) but would carry one scenario's cooldown into the next.
  await loadState(true);
}
const ALL_KEYS = {
  GROQ_API_KEY: "gsk_groq_zero", CEREBRAS_API_KEY: "csk-cerebras-key", OPENROUTER_API_KEY: "sk-or-free-tier",
  HF_TOKEN: "hf_router_token", GEMINI_API_KEY: "aiza-gemini-key", FIREWORKS_API_KEY: "fw-fireworks-key",
  TOGETHER_API_KEY: "tgether-api-key", DEEPSEEK_API_KEY: "sk-deepseek-key", OPENAI_API_KEY: "sk-openai-paid-key",
  NVIDIA_API_KEY: "nv-nim-api-key", MISTRAL_API_KEY: "mstrl-api-key", ZAI_API_KEY: "zai-bigmodel-key",
  DASHSCOPE_API_KEY: "dashscope-api-key", SAMBANOVA_API_KEY: "sambanova-api-key", ANTHROPIC_API_KEY: "sk-ant-api-key",
  COHERE_API_KEY: "cohere-api-key", MODAL_KEY: "modal-api-key", INCEPTION_API_KEY: "inception-api-key",
};
const names = (list: { name: string }[]) => list.map((x) => x.name);

// ═══════════════════════════════════════════════════════════════════════════
//  CATALOG
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("the free roster is back, and OpenRouter is in it", async () => {
  await reset(ALL_KEYS);
  const vendors = vendorsOf();
  for (const v of ["groq", "openrouter", "huggingface", "gemini", "cerebras", "fireworks", "together", "deepseek", "openai"]) {
    assert.ok(vendors.includes(v), `${v} missing from the live roster`);
  }
  assert.ok(vendors.length >= 9, `expected a broad roster, got ${vendors.length}`);
  // The regression this whole change exists to close: a catalog with three rows.
  assert.ok(catalogStatus().length >= 25, `catalog should describe every known vendor, got ${catalogStatus().length}`);
});

Deno.test("a vendor with no key is not instantiated, and says why", async () => {
  await reset({ GROQ_API_KEY: "gsk_only_groq_key" });
  const live = instances();
  assert.deepEqual(names(live).filter((n) => n !== "pollinations"), ["groq"]);
  const status = catalogStatus();
  assert.equal(status.find((s) => s.vendor === "groq")?.hasKey, true);
  assert.equal(status.find((s) => s.vendor === "openrouter")?.hasKey, false);
  assert.equal(status.find((s) => s.vendor === "openrouter")?.keyEnv, "OPENROUTER_API_KEY");
});

Deno.test("the keyless vendor means a zero-key deployment is degraded, not dead", async () => {
  await reset({});
  const live = instances();
  assert.deepEqual(names(live), ["pollinations"], "a fresh deployment must still be able to answer");
});

Deno.test("every key becomes its own instance: KEY, KEY1..KEY9, and comma lists", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_zero_a,gsk_slot_zero_b", GROQ_API_KEY1: "gsk_slot_one_value", GROQ_API_KEY3: "gsk_slot_three" });
  const groq = instances().filter((p) => p.vendor === "groq");
  assert.deepEqual(names(groq), ["groq", "groq#1", "groq#2", "groq#3"]);
  assert.deepEqual(groq.map((g) => g.key), ["gsk_slot_zero_a", "gsk_slot_zero_b", "gsk_slot_one_value", "gsk_slot_three"]);
  // Slot 0 keeps the bare vendor name, so `model: "groq"` still means the vendor.
  assert.equal(groq[0].name, "groq");
});

Deno.test("a malformed secret is reported, never called", async () => {
  await reset({ GEMINI_API_KEY: 'aiza_real_key…3, }', GROQ_API_KEY: "  gsk_padded_key_value  " });
  const gemini = instances().find((p) => p.vendor === "gemini")!;
  assert.match(gemini.keyIssue ?? "", /JSON punctuation/);
  // Surrounding whitespace is the one defect repaired silently.
  const groq = instances().find((p) => p.vendor === "groq")!;
  assert.equal(groq.key, "gsk_padded_key_value");
  assert.equal(groq.keyIssue, null);
  assert.equal(keyIssue('"quoted"'), "wrapped in quotes");
  assert.match(keyIssue("Bearer abc12345") ?? "", /whitespace|Bearer/,
    "a pasted Authorization header must be recognised, whichever check fires first");
  assert.equal(keyIssue("gsk_valid_key_value"), null);
});

Deno.test("${ENV} in a base URL is interpolated, and a missing var is a key issue", async () => {
  await reset({ CLOUDFLARE_API_KEY: "cf_token_value" });
  let cf = instances().find((p) => p.vendor === "cloudflare")!;
  assert.match(cf.keyIssue ?? "", /missing env CF_ACCOUNT_ID/);
  setEnv("CF_ACCOUNT_ID", "acct123");
  resetRoster();
  cf = instances().find((p) => p.vendor === "cloudflare")!;
  assert.equal(cf.keyIssue, null);
  assert.equal(cf.baseResolved, "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1");
  assert.ok(!cf.baseResolved.includes("${"), "an uninterpolated base URL throws at fetch time wearing a network error");
});

Deno.test("OMNI_DISABLE drops a vendor without editing the catalog", async () => {
  await reset({ ...ALL_KEYS, OMNI_DISABLE: "openrouter, groq" });
  const vendors = vendorsOf();
  assert.ok(!vendors.includes("openrouter") && !vendors.includes("groq"));
  assert.ok(vendors.includes("huggingface"), "disabling two vendors must not disable a third");
});

Deno.test("OMNI_PROVIDERS patches an existing row and adds a new one", async () => {
  await reset({
    ...ALL_KEYS,
    OMNI_PROVIDERS: JSON.stringify([
      { vendor: "groq", models: ["openai/gpt-oss-20b"] },
      { vendor: "acme", base: "https://api.acme.test/v1", keyEnv: "ACME_KEY", models: ["acme-1"] },
      { vendor: "broken" },
    ]),
    ACME_KEY: "acme_key_value",
  });
  const groq = instances().find((p) => p.vendor === "groq")!;
  assert.deepEqual(groq.models, ["openai/gpt-oss-20b"], "an existing row is patched field by field");
  assert.equal(groq.base, "https://api.groq.com/openai/v1", "unstated fields survive the merge");
  const acme = instances().find((p) => p.vendor === "acme");
  assert.ok(acme, "a new vendor is appended");
  assert.equal(acme!.baseResolved, "https://api.acme.test/v1");
  assert.ok(!vendorsOf().includes("broken"), "a new row without base+models is rejected, not half-added");
});

Deno.test("OMNI_PROVIDERS that is not JSON cannot take the catalog down", async () => {
  await reset({ ...ALL_KEYS, OMNI_PROVIDERS: "{not json" });
  assert.ok(vendorsOf().length >= 9);
});

Deno.test("tier decides rank: free before credit before paid, whatever the quality", async () => {
  await reset(ALL_KEYS);
  const rows = catalogStatus();
  const rankOf = (v: string) => rows.find((r) => r.vendor === v)!.rank;
  assert.ok(rankOf("groq") < rankOf("cerebras"), "free outranks a finite trial balance");
  assert.ok(rankOf("cerebras") < rankOf("deepseek"), "credit outranks metered");
  // deepseek-chat scores 90 and groq's qwen3.8-27b scores 85: tier still wins.
  assert.ok(quality("deepseek-chat") > quality("qwen/qwen3.8-27b"));
  assert.ok(rankOf("groq") < rankOf("deepseek"));
});

// ═══════════════════════════════════════════════════════════════════════════
//  `model` RESOLUTION — every documented spelling
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("auto/best/fast/empty all mean the whole roster", async () => {
  await reset(ALL_KEYS);
  const live = instances();
  for (const m of ["", "auto", "best", undefined, null]) {
    const t = resolveTargets(m as any, live);
    assert.equal(t.candidates.length, live.length, `model ${JSON.stringify(m)}`);
    assert.equal(t.mode, "quality");
    assert.equal(t.forcedModel, null);
  }
  assert.equal(resolveTargets("fast", live).mode, "latency");
  assert.equal(resolveTargets("FAST", live).mode, "latency", "meta-models are case-insensitive");
});

Deno.test("a capability tag puts tagged vendors first but keeps the rest reachable", async () => {
  await reset(ALL_KEYS);
  const t = resolveTargets("coder", instances());
  assert.equal(t.match, "tag");
  assert.equal(t.tag, "coder");
  assert.equal(t.candidates.length, instances().length, "a tag is a preference, never a hard subset");
  const first = t.candidates[0];
  assert.ok(first.tags?.includes("coder"), `${first.vendor} is not coder-tagged but ranked first`);
  const last = t.candidates[t.candidates.length - 1];
  assert.ok(!last.tags?.includes("coder"), "untagged vendors must still be in the list to degrade to");
});

Deno.test("a vendor name selects that vendor's key slots", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_c_zero,gsk_slot_c_one", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const t = resolveTargets("groq");
  assert.equal(t.match, "vendor");
  assert.deepEqual(names(t.candidates), ["groq", "groq#1"]);
  assert.equal(t.forcedModel, null);
});

Deno.test("vendor#n selects one key slot", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_c_zero,gsk_slot_c_one" });
  const t = resolveTargets("groq#1");
  assert.equal(t.match, "instance");
  assert.deepEqual(names(t.candidates), ["groq#1"]);
});

Deno.test("vendor:model pins one vendor and one upstream id", async () => {
  await reset(ALL_KEYS);
  for (const spelling of ["groq:openai/gpt-oss-120b", "groq/openai/gpt-oss-120b"]) {
    const t = resolveTargets(spelling);
    assert.deepEqual(names(t.candidates), ["groq"], spelling);
    assert.equal(t.forcedModel, "openai/gpt-oss-120b", spelling);
  }
});

Deno.test("a bare upstream id finds every vendor that serves it", async () => {
  await reset(ALL_KEYS);
  // This is what makes the endpoint a drop-in for an OpenAI SDK pointed at it.
  const t = resolveTargets("openai/gpt-oss-120b");
  assert.equal(t.match, "model");
  assert.equal(t.forcedModel, "openai/gpt-oss-120b");
  assert.ok(t.candidates.length >= 3, "groq, sambanova, huggingface and others all serve this id");
  // The collision that rule ordering exists to resolve: `openai` is BOTH a paid
  // vendor in the catalog and the org prefix of a model many free vendors serve.
  assert.ok(!names(t.candidates).includes("openai"), "openai/gpt-oss-120b must not be read as a pin to OpenAI");
  const own = resolveTargets("openai/gpt-5-mini");
  assert.deepEqual(names(own.candidates), ["openai"], "openai's OWN model still resolves to openai");
  assert.equal(own.forcedModel, "gpt-5-mini");
});

Deno.test("an OpenRouter :free id resolves to openrouter, not to the nvidia vendor", async () => {
  await reset(ALL_KEYS);
  const t = resolveTargets("nvidia/nemotron-3-super-120b-a12b:free");
  assert.deepEqual(names(t.candidates), ["openrouter"]);
  assert.equal(t.forcedModel, "nvidia/nemotron-3-super-120b-a12b:free");
  // …which is exactly why the NVIDIA vendor keeps its `_nim` suffix.
  assert.ok(!vendorsOf().includes("nvidia"), "a vendor named `nvidia` would swallow OpenRouter's nvidia/* ids");
  const nim = resolveTargets("nvidia_nim:nvidia/llama-3.1-nemotron-51b-instruct");
  assert.deepEqual(names(nim.candidates), ["nvidia_nim"]);
});

Deno.test("an unknown model is a 404 with the accepted values attached, never a reroute", async () => {
  await reset(ALL_KEYS);
  const t = resolveTargets("definitely-not-a-model");
  assert.equal(t.match, "none");
  assert.equal(t.candidates.length, 0);
  const known = knownModelValues();
  assert.ok(known.includes("auto") && known.includes("coder") && known.includes("groq"));
  assert.ok(known.includes("openai/gpt-oss-120b"), "real model ids are advertised so a 404 is self-service");
});

// ═══════════════════════════════════════════════════════════════════════════
//  PROMPT MATHS
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("max_tokens is clamped by the vendor's output cap and its token meter", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", HF_TOKEN: "hf_router_token" });
  const groq = instances().find((p) => p.vendor === "groq")!;
  assert.equal(groq.maxOut, 5500);
  assert.equal(groq.tpm, 6000);
  // A small prompt: the per-request output cap binds.
  assert.equal(clampMaxTokens(groq, 500, 16_000), 5500);
  // A big prompt: what is left of the minute's meter binds. This is the case that
  // used to produce a 429 reading like a rate limit and was really arithmetic.
  assert.equal(clampMaxTokens(groq, 4000, 16_000), 2000);
  // Floored at 256: reasoning models spend max_tokens on thinking first, and a
  // smaller grant returns finish_reason "length" with empty content.
  assert.equal(clampMaxTokens(groq, 5990, 16_000), 256);
  // A vendor with no declared caps takes what it is asked for.
  const hf = instances().find((p) => p.vendor === "huggingface")!;
  assert.equal(clampMaxTokens(hf, 1000, 16_000), 16_000);
});

Deno.test("promptFits uses the catalog ceiling and a learned one, whichever is lower", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const groq = instances().find((p) => p.vendor === "groq")!;
  assert.equal(promptFits(groq, 6500), true);
  assert.equal(promptFits(groq, 6501), false);
  assert.equal(promptFits(groq, 3000, 2000), false, "a ceiling learned from a real 413 beats the catalog");
  const uncapped = instances().find((p) => p.vendor === "openrouter")!;
  assert.equal(promptFits(uncapped, 500_000), true);
});

Deno.test("token estimation counts content parts and tool schemas", async () => {
  const msgs = [{ role: "user", content: "x".repeat(400) }, { role: "assistant", content: [{ type: "text", text: "y".repeat(400) }] }];
  const bare = estimateTokens(msgs);
  assert.ok(bare >= 200 && bare <= 220, `expected ≈200 tokens, got ${bare}`);
  const withTools = estimateTokens(msgs, [{ name: "t", description: "z".repeat(400) }]);
  assert.ok(withTools > bare + 90, "tool schemas are prompt tokens too, and they are what pushes a free tier over");
});

// ═══════════════════════════════════════════════════════════════════════════
//  RANKING
// ═══════════════════════════════════════════════════════════════════════════
const ctx = (over: Partial<RankCtx> = {}): RankCtx => ({
  mode: "quality", tag: null, forcedModel: null, promptTokens: 500, expectTokens: 1500,
  vendorOrder: [], exclude: new Set(), keyPolicy: "breadth", now: Date.now(), ...over,
});

Deno.test("auto ranks by model quality within a tier, and never spends money first", async () => {
  await reset(ALL_KEYS);
  const { order } = rankCandidates(resolveTargets("auto"), ctx());
  const tiers = order.map((p) => p.tier);
  const firstPaid = tiers.indexOf("paid");
  const lastFree = tiers.lastIndexOf("free");
  assert.ok(firstPaid > lastFree, "every free instance outranks every paid one, whatever the model quality");
  const firstCredit = tiers.indexOf("credit");
  assert.ok(firstCredit > lastFree, "a finite trial balance ranks after a recurring free tier");
  // Hugging Face's DeepSeek-V4-Pro (95) must come before Groq's qwen3.8-27b (85).
  assert.ok(order.findIndex((p) => p.vendor === "huggingface") < order.findIndex((p) => p.vendor === "groq"));
});

Deno.test("fast ranks on the ETA of a COMPLETE reply, not on throughput alone", async () => {
  await reset(ALL_KEYS);
  const { order } = rankCandidates(resolveTargets("fast"), ctx({ mode: "latency", expectTokens: 1500 }));
  const eta = (v: string) => {
    const p = order.find((x) => x.vendor === v)!;
    return etaMs(p, 1500);
  };
  // Cerebras: 400ms ttft at 1200 tps ≈ 1.7s. OpenRouter: 4000ms ttft at 30 tps ≈ 54s.
  assert.ok(eta("cerebras") < eta("groq"), "cerebras is the fastest silicon in the roster");
  assert.ok(eta("groq") < eta("openrouter"), "openrouter's free tier is a width provider, not a speed one");
  const etas = order.filter((p) => p.tier === "free").map((p) => etaMs(p, 1500));
  assert.deepEqual(etas, [...etas].sort((a, b) => a - b), "free instances come out in ascending ETA");
});

Deno.test("a capability tag outranks quality inside its tier", async () => {
  await reset(ALL_KEYS);
  const { order } = rankCandidates(resolveTargets("coder"), ctx({ tag: "coder" as any }));
  const free = order.filter((p) => p.tier === "free");
  const tagged = free.map((p) => !!p.tags?.includes("coder"));
  const lastTagged = tagged.lastIndexOf(true);
  const firstUntagged = tagged.indexOf(false);
  assert.ok(lastTagged < firstUntagged,
    `no untagged instance may outrank a tagged one, got ${free.map((p) => p.vendor + (p.tags?.includes("coder") ? "*" : ""))}`);
  assert.ok(tagged.filter(Boolean).length >= 2, "at least two keyed vendors are coder-tagged");
});

Deno.test("vendor round-robin stops one vendor's key slots eating every funded attempt", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_a_zero,gsk_slot_a_one,gsk_slot_a_two,gsk_slot_a_three,gsk_slot_a_four", OPENROUTER_API_KEY: "sk-or-free-tier", HF_TOKEN: "hf_router_token" });
  const { order } = rankCandidates(resolveTargets("auto"), ctx());
  const vendorCount = vendorsOf().length;
  const lead = names(order).slice(0, vendorCount);
  const distinct = new Set(lead.map((n) => n.split("#")[0]));
  assert.equal(distinct.size, vendorCount,
    `one vendor's key slots must not eat the funded attempts: led with ${lead} across ${vendorCount} vendors`);
  // No vendor appears a second time before every vendor has appeared once.
  const seen = new Set<string>();
  for (const n of names(order)) {
    const v = n.split("#")[0];
    if (seen.has(v)) break;
    seen.add(v);
  }
  assert.equal(seen.size, vendorCount, `breadth-first ordering, got ${names(order)}`);
});

Deno.test("keyPolicy depth keeps a vendor's slots adjacent; rr leads with the least-used", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_b_zero,gsk_slot_b_one,gsk_slot_b_two" });
  const t = resolveTargets("groq");
  const depth = rankCandidates(t, ctx({ keyPolicy: "depth" })).order;
  assert.deepEqual(names(depth), ["groq", "groq#1", "groq#2"]);
  // Give slot 0 a history so `rr` has something to rank against.
  await bumpProviderStats("groq", false, "boom", Date.now());
  await bumpProviderStats("groq", false, "boom", Date.now());
  await bumpProviderStats("groq", false, "boom", Date.now());
  await loadState(true);
  const rr = rankCandidates(t, ctx({ keyPolicy: "rr" })).order;
  assert.equal(rr[0].name, "groq#1", `least-used slot first, got ${names(rr)}`);
});

Deno.test("measured health decides between instances that otherwise tie", async () => {
  // Health is the 5th comparator: below tier, quality and mode. It therefore only
  // gets a say between instances that are otherwise equal — which is exactly a
  // vendor's own key slots, and exactly the case where it matters, because five
  // slots of one vendor and a 3-attempt budget is a coin flip otherwise.
  await reset({ GROQ_API_KEY: "gsk_slot_h_zero,gsk_slot_h_one,gsk_slot_h_two" });
  const t = resolveTargets("groq");
  const before = names(rankCandidates(t, ctx({ keyPolicy: "depth" })).order);
  assert.deepEqual(before, ["groq", "groq#1", "groq#2"], "with no history, declaration order");
  for (let i = 0; i < 12; i++) await bumpProviderStats("groq", false, "HTTP 500", Date.now());
  await loadState(true);
  const after = names(rankCandidates(t, ctx({ keyPolicy: "depth", now: Date.now() })).order);
  assert.equal(after[after.length - 1], "groq", `12 failures must sink the slot that took them: ${after}`);
  // The same record, measured three weeks ago, is much weaker evidence than a
  // fresh one — so a slot with an OLD bad record must outrank a slot with a NEW
  // bad record. Comparing against an untried slot cannot show this: untried sits
  // at exactly neutral (0.5) and decay only ever approaches neutral from below.
  // Aged through bumpProviderStats' own `ts` argument, so the decay under test is
  // the real code path rather than a hand-edited row.
  await resetProviderStats();
  const threeWeeksAgo = Date.now() - 21 * 86_400_000;
  for (let i = 0; i < 12; i++) await bumpProviderStats("groq", false, "HTTP 500", threeWeeksAgo);
  for (let i = 0; i < 4; i++) await bumpProviderStats("groq#1", false, "HTTP 500", Date.now());
  await loadState(true);
  const aged = names(rankCandidates(t, ctx({ keyPolicy: "depth" })).order);
  assert.ok(aged.indexOf("groq") < aged.indexOf("groq#1"),
    `a three-week-old record must decay below a fresh one, or a fixed vendor stays exiled: ${aged}`);
});

Deno.test("an untried instance is neutral, not guilty", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_c_zero,gsk_slot_c_one" });
  await bumpProviderStats("groq", false, "boom", Date.now());
  await bumpProviderStats("groq", false, "boom", Date.now());
  await loadState(true);
  const { order } = rankCandidates(resolveTargets("groq"), ctx({ keyPolicy: "depth" }));
  assert.equal(order[0].name, "groq#1", "the slot with one failure ranks below the slot with none");
});

Deno.test("a cooling instance goes to the tail but is never dropped", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", HF_TOKEN: "hf_router_token", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const t = resolveTargets("auto");
  await bumpProviderStats("groq", false, "HTTP 500", Date.now());
  await loadState(true);
  // One failure is a strike; two opens the breaker.
  const before = names(rankCandidates(t, ctx()).order);
  assert.ok(before.includes("groq"), "groq is in the roster before any cooldown");
  // Drive it through the public path: two strikes via a real failed route.
  const real = await driveFailures("groq", 2);
  assert.ok(real, "groq should now be cooling");
  const after = names(rankCandidates(t, ctx({ now: Date.now() })).order);
  assert.equal(after[after.length - 1], "groq", `cooling goes last but stays in the list: ${after}`);
});

Deno.test("a prompt too large for a vendor skips it without spending an attempt", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const { order, skipped } = rankCandidates(resolveTargets("auto"), ctx({ promptTokens: 9000 }));
  assert.ok(!order.some((p) => p.vendor === "groq"), "groq's 6500-token ceiling means it is never called");
  const why = skipped.find((s) => s.vendor === "groq")!;
  assert.match(why.why, /exceeds its 6500 tok input limit/);
  assert.match(why.why, /reduce the message size/i, "the reason must be something the caller can act on");
  assert.ok(order.some((p) => p.vendor === "openrouter"), "an uncapped vendor still answers");
});

Deno.test("exclude drops exactly what the caller named — instance, vendor, or slot", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_c_zero,gsk_slot_c_one", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const t = resolveTargets("auto");
  assert.ok(!names(rankCandidates(t, ctx({ exclude: new Set(["groq#1"]) })).order).includes("groq#1"));
  assert.ok(names(rankCandidates(t, ctx({ exclude: new Set(["groq#1"]) })).order).includes("groq"));
  assert.ok(!names(rankCandidates(t, ctx({ exclude: new Set(["groq"]) })).order).some((n) => n.startsWith("groq")));
  const { skipped } = rankCandidates(t, ctx({ exclude: new Set(["groq"]) }));
  assert.equal(skipped.find((s) => s.name === "groq")?.why, "excluded by caller");
});

Deno.test("vendorOrder promotes without excluding", async () => {
  await reset(ALL_KEYS);
  const { order } = rankCandidates(resolveTargets("auto"), ctx({ vendorOrder: ["openrouter"] }));
  assert.equal(order[0].vendor, "openrouter");
  assert.ok(order.length === instances().length, "a preference is a reordering, never a subset");
});

Deno.test("a malformed secret is skipped, and the reason names the env var", async () => {
  await reset({ GEMINI_API_KEY: '"quoted-key-value"', GROQ_API_KEY: "gsk_valid_key_value" });
  const { order, skipped } = rankCandidates(resolveTargets("auto"), ctx());
  assert.ok(!order.some((p) => p.vendor === "gemini"));
  assert.match(skipped.find((s) => s.vendor === "gemini")!.why, /GEMINI_API_KEY.*wrapped in quotes/);
});

/** Drive N real failures through routeChat so the cooldown path is exercised,
 *  not just asserted about. Returns whether the instance ended up cooling. */
async function driveFailures(vendor: string, n: number): Promise<boolean> {
  const fetchImpl = installFetch(() => new Response("upstream 500", { status: 500 }));
  try {
    for (let i = 0; i < n; i++) {
      await routeChat([{ role: "user", content: "hi" }], { model: vendor, deadlineMs: 8000 }).catch(() => {});
    }
  } finally { restoreFetch(fetchImpl); }
  return isCooling(vendor);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════
type Recorded = { url: string; body: any; headers: Record<string, string> };
let RECORDED: Recorded[] = [];
function installFetch(handler: (url: string, init: any, call: number) => Response | Promise<Response>) {
  const prev = globalThis.fetch;
  RECORDED = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const rec: Recorded = { url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: (init?.headers ?? {}) as any };
    RECORDED.push(rec);
    const out = handler(rec.url, init, RECORDED.length);
    const signal: AbortSignal | undefined = init?.signal;
    if (!signal) return out;
    // Real fetch rejects when its signal aborts. A stub that ignored the signal
    // would let a hung vendor hang the whole endpoint — which is precisely the
    // failure the router's per-call deadlines exist to prevent, so not modelling
    // it would let the tests pass against a router that has no timeout at all.
    return Promise.race([
      Promise.resolve(out),
      new Promise<Response>((_res, rej) => {
        const onAbort = () => rej(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  };
  return prev;
}
const restoreFetch = (prev: typeof fetch) => { (globalThis as any).fetch = prev; };
const okReply = (content = "hello", extra: Record<string, unknown> = {}) =>
  Response.json({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra });

Deno.test("the first healthy provider answers, and nothing else is called", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("from groq"));
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "groq", deadlineMs: 8000 });
    assert.equal(hit.provider.vendor, "groq");
    assert.match(hit.text ?? "", /from groq/);
    assert.equal(RECORDED.length, 1);
    assert.equal(RECORDED[0].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(RECORDED[0].headers.Authorization, "Bearer gsk_groq_slot0");
    assert.equal(hit.maxTokensSent, 4096, "an unsized request asks for a sane default, not the caller's 0");
  } finally { restoreFetch(prev); }
});

Deno.test("failure fails over to the next vendor, and the trail records both", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq") ? new Response("nope", { status: 500 }) : okReply("from openrouter"));
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000 });
    assert.equal(hit.provider.vendor, "openrouter");
    const tried = (hit.trail ?? []).filter((t) => !t.skipped);
    assert.deepEqual(tried.map((t) => [t.vendor, t.ok]), [["groq", false], ["openrouter", true]]);
    assert.ok((hit.plan ?? []).length >= 2);
  } finally { restoreFetch(prev); }
});

Deno.test("a retired model id falls through the vendor's own list, then discovery", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch((url, _init, call) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "openai/gpt-oss-120b" }, { id: "whisper-large-v3" }, { id: "llama-guard-4" }] });
    const body = JSON.parse((_init as any).body);
    if (body.model === "qwen/qwen3.8-27b") return Response.json({ error: { message: "The model `qwen/qwen3.8-27b` does not exist", type: "invalid_request_error" } }, { status: 404 });
    void call;
    return okReply("from the fallback id");
  });
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "groq", deadlineMs: 12_000 });
    assert.equal(hit.model, "openai/gpt-oss-120b", "the vendor's next listed id, not another vendor");
    assert.equal(hit.provider.vendor, "groq");
    const dead = (stateView().dead_models as string[]);
    assert.ok(dead.some((k) => k.endsWith("qwen/qwen3.8-27b")), "the retired id is remembered so the next call skips it");
  } finally { restoreFetch(prev); }
});

Deno.test("discovery never picks a guard, moderation, ASR or embedding endpoint", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch((url) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "llama-guard-4-12b" }, { id: "whisper-large-v3-turbo" }, { id: "all-MiniLM-L6-v2" }, { id: "openai/gpt-oss-20b" }] });
    return okReply("ok");
  });
  try {
    const p = instances().find((x) => x.vendor === "groq")!;
    const found = await discoverModel(p, 4000);
    assert.equal(found, "openai/gpt-oss-20b");
  } finally { restoreFetch(prev); }
});

Deno.test("a 400 that names a parameter drops exactly that parameter and retries once", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch((_url, init) => {
    const body = JSON.parse((init as any).body);
    if (body.response_format) {
      return Response.json({ error: { message: "`response_format` is not supported by this model" } }, { status: 400 });
    }
    return okReply("without the accused parameter");
  });
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "groq", deadlineMs: 8000, response_format: { type: "json_object" } });
    assert.match(hit.text ?? "", /without the accused parameter/);
    assert.equal(RECORDED.length, 2, "exactly one repair retry, not a loop");
    assert.ok(RECORDED[0].body.response_format, "the first call sends what the caller asked for");
    assert.equal(RECORDED[1].body.response_format, undefined);
    assert.ok(RECORDED[1].body.max_tokens, "only the accused parameter is dropped");
    assert.deepEqual((hit.trail ?? []).find((t) => t.dropped)?.dropped, ["response_format"]);
  } finally { restoreFetch(prev); }
});

Deno.test("429 honours retry-after and cools the instance for at least that long", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq")
    ? new Response("Rate limit reached, try again in 30s", { status: 429, headers: { "retry-after": "30" } })
    : okReply("from openrouter"));
  try {
    // vendorOrder puts the vendor under test first; `auto` alone would rank a
    // better-quality vendor ahead of it and it would never be called at all.
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000, vendorOrder: ["groq"] });
    assert.equal(hit.provider.vendor, "openrouter", "the 429'd vendor fails over to the next one");
    const info = cooldownInfo("groq")!;
    assert.ok(info.until - Date.now() >= 29_000, `retry-after must be honoured, got ${info.until - Date.now()}ms`);
    assert.match(info.reason, /retry after 30s/);
  } finally { restoreFetch(prev); }
});

Deno.test("a per-day quota 429 and a 402 cool for an hour, not eight seconds", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq")
    ? new Response("You have exceeded your daily limit of 1000 requests per day", { status: 429 })
    : okReply("ok"));
  try {
    await routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000, vendorOrder: ["groq"] }).catch(() => {});
    assert.ok(cooldownInfo("groq")!.until - Date.now() > 3_000_000, "a daily cap does not reset in eight seconds");
  } finally { restoreFetch(prev); }
});

Deno.test("401 is a key problem: cooled long and never retried inside the call", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  let groqCalls = 0;
  const prev = installFetch((url) => {
    if (url.includes("groq")) { groqCalls++; return new Response("invalid api key", { status: 401 }); }
    return okReply("ok");
  });
  try {
    await routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000, vendorOrder: ["groq"] }).catch(() => {});
    assert.equal(groqCalls, 1, "an auth failure is not transient; hammering it is how an account gets flagged");
    assert.match(cooldownInfo("groq")!.reason, /key or account tier/);
  } finally { restoreFetch(prev); }
});

Deno.test("a 413 teaches the router the real input ceiling, and the next call skips it", async () => {
  await reset({ OPENROUTER_API_KEY: "sk-or-free-tier", HF_TOKEN: "hf_router_token" });
  const prev = installFetch((url) => url.includes("huggingface")
    ? new Response("This model's maximum context length is 8192 tokens", { status: 400 })
    : okReply("ok"));
  try {
    await routeChat([{ role: "user", content: "hi" }], { model: "huggingface", deadlineMs: 8000 }).catch(() => {});
    const learned = capInFor(instances().find((p) => p.vendor === "huggingface")!, "deepseek-ai/DeepSeek-V4-Pro");
    assert.ok(learned && learned < 1000, `a ceiling was learned from the real failure, got ${learned}`);
    const { skipped } = rankCandidates(resolveTargets("huggingface"), ctx({ promptTokens: 900 }));
    assert.ok(skipped.length, "the next oversized prompt is refused without a wasted call");
  } finally { restoreFetch(prev); }
});

Deno.test("every vendor failing produces a 503 that says what to do, per provider", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch(() => new Response("down", { status: 503 }));
  try {
    await assert.rejects(
      () => routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000 }),
      (e: any) => {
        assert.equal(e.status, 503);
        assert.equal(e.code, "EXHAUSTED_ALL");
        assert.match(e.message, /ALL_PROVIDERS_EXHAUSTED/);
        assert.match(e.message, /groq: HTTP 503/, "each provider's own error is in the message");
        assert.ok(e.tried >= 2);
        return true;
      },
    );
  } finally { restoreFetch(prev); }
});

Deno.test("no candidate can fit the prompt → a structured 413, not a provider-shaped 503", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("should never be called"));
  try {
    await assert.rejects(
      () => routeChat([{ role: "user", content: "x".repeat(120_000) }], { model: "groq", deadlineMs: 8000 }),
      (e: any) => {
        assert.equal(e.status, 413);
        assert.equal(e.code, "PROMPT_TOO_LARGE");
        assert.match(e.message, /reduce the message size/i);
        assert.equal(RECORDED.length, 0, "not one provider was called for a request none of them could take");
        return true;
      },
    );
  } finally { restoreFetch(prev); }
});

Deno.test("an unknown model is a 404 and never silently rerouted", async () => {
  await reset(ALL_KEYS);
  const prev = installFetch(() => okReply());
  try {
    await assert.rejects(
      () => routeChat([{ role: "user", content: "hi" }], { model: "gpt-4-turbo", deadlineMs: 8000 }),
      (e: any) => { assert.equal(e.status, 404); assert.equal(e.code, "UNKNOWN_MODEL"); assert.match(e.message, /Refusing to guess/); return true; },
    );
    assert.equal(RECORDED.length, 0);
  } finally { restoreFetch(prev); }
});

Deno.test("an empty or dots-only reply is rejected and the next provider is tried", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq")
    ? Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "..." }, finish_reason: "stop" }] })
    : okReply("a real answer"));
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000 });
    assert.equal(hit.provider.vendor, "openrouter");
  } finally { restoreFetch(prev); }
});

Deno.test("a reasoning-only reply is truncated, not empty, and is accepted", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => Response.json({
    choices: [{ index: 0, message: { role: "assistant", content: "", reasoning: "let me think about this at length" }, finish_reason: "length" }],
    usage: { completion_tokens: 200 },
  }));
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "groq", deadlineMs: 8000 });
    assert.equal(hit.provider.vendor, "groq", "rejecting this would punish a provider that worked and hide the finish_reason");
  } finally { restoreFetch(prev); }
});

Deno.test("a 200 carrying an error body is not a success", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq")
    ? Response.json({ error: { message: "credit balance is zero" } })
    : okReply("ok"));
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 12_000 });
    assert.equal(hit.provider.vendor, "openrouter");
  } finally { restoreFetch(prev); }
});

Deno.test("the caller's deadline is an instant, and a route cannot outlive it", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier", HF_TOKEN: "hf_router_token" });
  const prev = installFetch(() => new Promise<Response>((r) => setTimeout(() => r(okReply("too late")), 6000)));
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineAt: t0 + 3000 }),
      (e: any) => { assert.ok(["TIME_EXHAUSTED", "EXHAUSTED_ALL", "NO_BUDGET", "CALL_DEADLINE"].includes(e.code), `got ${e.code}`); return true; },
    );
    const spent = Date.now() - t0;
    assert.ok(spent < 5000, `a 3000ms grant ran for ${spent}ms — this is the exact bug the absolute instant exists to prevent`);
  } finally { restoreFetch(prev); }
});

Deno.test("a deadline too small for one attempt reports NO_BUDGET, not a provider failure", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch(() => okReply());
  try {
    await assert.rejects(
      () => routeChat([{ role: "user", content: "hi" }], { model: "auto", deadlineMs: 300 }),
      (e: any) => {
        assert.equal(e.code, "NO_BUDGET");
        assert.match(e.message, /NOT a provider problem|QUEUEING/);
        assert.equal(RECORDED.length, 0);
        return true;
      },
    );
  } finally { restoreFetch(prev); }
});

Deno.test("concurrency is capped and the queue is charged to the caller's deadline", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  let live = 0, peak = 0;
  const prev = installFetch(async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 300));
    live--;
    return okReply("ok");
  });
  try {
    const calls = Array.from({ length: MAX_CONCURRENCY + 3 }, () =>
      routeChat([{ role: "user", content: "hi" }], { model: "groq", deadlineMs: 20_000 }));
    const settled = await Promise.allSettled(calls);
    assert.ok(peak <= MAX_CONCURRENCY, `peak concurrency ${peak} exceeded the cap ${MAX_CONCURRENCY}`);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, calls.length);
    assert.equal(inflight, 0, "every admitted call released its slot");
  } finally { restoreFetch(prev); }
});

Deno.test("a stalled stream body is cut by the idle watchdog, not left hanging", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  setEnv("OMNI_STREAM_IDLE_MS", "400");
  const prev = installFetch((_url, init) => {
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
        // Headers are already out, so the router's call deadline has been released
        // and only the idle watchdog can end this. Real fetch errors the body when
        // its signal aborts; the stub has to do the same or the watchdog's abort
        // would be unobservable and the test would pass against a broken watchdog.
        (init as any)?.signal?.addEventListener("abort", () => { try { c.error(new Error("aborted by idle watchdog")); } catch { /* already closed */ } }, { once: true });
        await new Promise((r) => setTimeout(r, 5000)); // then silence, forever
        try { c.close(); } catch { /* torn down already */ }
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const hit = await routeChat([{ role: "user", content: "hi" }], { model: "groq", stream: true, deadlineMs: 20_000 });
    const reader = hit.res!.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, "the first chunk arrives");
    const t0 = Date.now();
    const rest = await Promise.race([
      reader.read()
        .then((r) => ({ ended: r.done ? "closed" : "chunk", waited: Date.now() - t0 }))
        .catch(() => ({ ended: "errored", waited: Date.now() - t0 })),
      new Promise<{ ended: string; waited: number }>((res) => setTimeout(() => res({ ended: "still hanging", waited: Date.now() - t0 }), 3000)),
    ]);
    assert.ok(rest.waited < 2000,
      `the idle watchdog should have torn the stream down well inside 3s, took ${rest.waited}ms (${rest.ended})`);
    assert.notEqual(rest.ended, "still hanging");
  } finally { restoreFetch(prev); unsetEnv("OMNI_STREAM_IDLE_MS"); }
});

Deno.test("a success clears the cooldown it was carrying", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  await driveFailures("groq", 2);
  assert.ok(isCooling("groq"));
  const prev = installFetch(() => okReply("back up"));
  try {
    // A cooling instance is still tried when it is the only candidate.
    await routeChat([{ role: "user", content: "hi" }], { model: "groq", deadlineMs: 8000 });
    assert.ok(!isCooling("groq"), "one success must be enough to restore an instance");
  } finally { restoreFetch(prev); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE OPENAI SURFACE
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("every documented OpenAI parameter reaches the provider", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("ok"));
  try {
    // reasoning_effort is the one that mattered: the README told callers to send
    // it, the client sent it, and the router dropped it — so a reasoning model
    // could never be told to think less when the deadline was short.
    const r = await chatCompletions({
      model: "groq", messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low", temperature: 0.3, top_p: 0.9, stop: ["END"], seed: 7,
      presence_penalty: 0.1, frequency_penalty: 0.2, n: 1, user: "u1", logprobs: false,
      tools: [{ type: "function", function: { name: "f" } }], tool_choice: "auto",
      response_format: { type: "json_object" },
    });
    assert.equal(r.status, 200);
    const sent = RECORDED[0].body;
    for (const k of ["reasoning_effort", "temperature", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "n", "user", "logprobs", "tools", "tool_choice", "response_format"]) {
      assert.ok(sent[k] !== undefined, `${k} was dropped between the caller and the provider`);
    }
    assert.equal(sent.reasoning_effort, "low");
    // Router extensions are consumed, never forwarded upstream.
    for (const k of ["omni_deadline_ms", "omni_deadline_at", "omni_key_policy", "omni_vendor_order", "omni_exclude", "omni_expect_tokens", "omni_auth"]) {
      assert.equal(sent[k], undefined, `${k} leaked to the provider`);
    }
  } finally { restoreFetch(prev); }
});

Deno.test("max_completion_tokens goes out under the name the caller used", async () => {
  await reset({ OPENAI_API_KEY: "sk-openai-paid-key" });
  const prev = installFetch(() => okReply("ok"));
  try {
    await chatCompletions({ model: "openai", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 2000 });
    const sent = RECORDED[0].body;
    assert.ok(sent.max_completion_tokens > 0, "gpt-5 rejects max_tokens outright");
    assert.equal(sent.max_tokens, undefined);
    await chatCompletions({ model: "openai", messages: [{ role: "user", content: "hi" }], max_tokens: 2000 });
    assert.ok(RECORDED[1].body.max_tokens > 0);
    assert.equal(RECORDED[1].body.max_completion_tokens, undefined);
  } finally { restoreFetch(prev); }
});

Deno.test("tool_choice:none suppresses the tools array, which Groq rejects", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("ok"));
  try {
    await chatCompletions({ model: "groq", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }], tool_choice: "none" });
    assert.equal(RECORDED[0].body.tools, undefined);
    assert.equal(RECORDED[0].body.tool_choice, undefined);
  } finally { restoreFetch(prev); }
});

Deno.test("_omni_meta carries provenance and the routing trail", async () => {
  await reset({ GROQ_API_KEY: "gsk_slot_c_zero,gsk_slot_c_one", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq") ? new Response("down", { status: 500 }) : okReply("ok"));
  try {
    const r = await chatCompletions({ model: "auto", messages: [{ role: "user", content: "hi" }], omni_vendor_order: "groq" });
    const m = r.json._omni_meta;
    assert.equal(m.provider.vendor, "openrouter");
    assert.equal(m.instance, "openrouter");
    assert.ok(!("key" in m.provider), "no key material in a response body, ever");
    assert.ok(Array.isArray(m.plan) && m.plan.length >= 2);
    assert.ok(m.attempts.some((a: any) => a.vendor === "groq" && !a.ok));
    assert.ok(m.attempts.some((a: any) => a.vendor === "openrouter" && a.ok));
    assert.equal(typeof m.max_tokens_sent, "number");
  } finally { restoreFetch(prev); }
});

Deno.test("an empty payload is a 400, and `prompt` is accepted as a shorthand", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("ok"));
  try {
    assert.equal((await chatCompletions({ messages: [] })).status, 400);
    assert.equal((await chatCompletions({})).status, 400);
    const r = await chatCompletions({ model: "groq", prompt: "say hi" });
    assert.equal(r.status, 200);
    assert.deepEqual(RECORDED[0].body.messages, [{ role: "user", content: "say hi" }]);
  } finally { restoreFetch(prev); }
});

Deno.test("the router's own keys and vendor order settings are honoured", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier", HF_TOKEN: "hf_router_token" });
  const prev = installFetch(() => new Response("down", { status: 500 }));
  try {
    await chatCompletions({
      model: "auto", messages: [{ role: "user", content: "hi" }],
      omni_vendor_order: "huggingface", omni_exclude: ["groq", "openrouter", "pollinations"], deadlineMs: 8000,
    });
    assert.ok(RECORDED.length > 0, "the call reached a provider");
    assert.ok(RECORDED.every((r) => r.url.includes("huggingface")),
      `the settings panel's vendor order and exclude fields were dead until now; called ${RECORDED.map((r) => new URL(r.url).host)}`);
  } finally { restoreFetch(prev); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP ROUTES
// ═══════════════════════════════════════════════════════════════════════════
const get = (path: string, init?: any) => routerRoutes(new Request(`https://free-ai.val.run${path}`, { method: "GET", ...init }));
const post = (path: string, body: unknown, init?: any) => routerRoutes(new Request(`https://free-ai.val.run${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init,
}));

Deno.test("app routes are left alone: routerRoutes returns null for anything it does not own", async () => {
  await reset(ALL_KEYS);
  assert.equal(await routerRoutes(new Request("https://free-ai.val.run/?q=hello", { method: "POST", body: "{}" })), null, "POST /?q= is the chat app");
  assert.equal(await routerRoutes(new Request("https://free-ai.val.run/?build_start", { method: "POST", body: "{}" })), null);
  assert.equal(await routerRoutes(new Request("https://free-ai.val.run/?sessions")), null);
  assert.equal(await routerRoutes(new Request("https://free-ai.val.run/artifact/1/index.html")), null);
  assert.equal(await routerRoutes(new Request("https://free-ai.val.run/")), null, "GET / is the chat UI, not the router matrix");
  assert.equal(await routerRoutes(new Request("https://free-ai.val.run/nope")), null);
});

Deno.test("a bare POST / with a JSON body is an OpenAI client, and is served", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("from the root path"));
  try {
    const res = await post("/", { model: "groq", messages: [{ role: "user", content: "hi" }] });
    assert.ok(res, "POST / is a documented chat.completions path");
    const body = await res!.json();
    assert.match(body.choices[0].message.content, /from the root path/);
  } finally { restoreFetch(prev); }
});

Deno.test("/health reports the roster, the tiers, cooldowns and the gates", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", GEMINI_API_KEY: "aiza-gemini-key", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const res = await get("/health");
  const h = await res!.json();
  assert.equal(h.status, "ok");
  // pollinations needs no key, so it is always configured: three keyed vendors
  // plus the keyless fallback.
  assert.equal(h.providers_configured, 4);
  assert.equal(h.vendors, 4);
  assert.deepEqual(h.by_tier, { free: 4 });
  assert.equal(h.auth.client_keys, false);
  assert.ok(h.instances.some((i: any) => i.name === "groq"));
  assert.ok(h.key_policy.includes("round-robin"));
  // A malformed key is the most common "why does X never work", so it is top-level.
  setEnv("GEMINI_API_KEY", "aiza_gemini…3, }");
  resetRoster();
  const h2 = await (await get("/health")).json();
  assert.equal(h2.status, "ok-with-key-issues");
  assert.equal(h2.key_issues[0].env, "GEMINI_API_KEY");
});

Deno.test("/api/providers describes every catalog row, keyed or not, with no key material", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const rows = await (await get("/api/providers"))!.json();
  assert.ok(rows.length >= 25);
  const groq = rows.find((r: any) => r.vendor === "groq");
  assert.equal(groq.hasKey, true);
  assert.equal(groq.keySlots, 1);
  assert.equal(groq.currentModel, "qwen/qwen3.8-27b");
  const or = rows.find((r: any) => r.vendor === "openrouter");
  assert.equal(or.hasKey, false);
  assert.equal(or.keyEnv, "OPENROUTER_API_KEY", "the UI must be able to say which secret to add");
  const text = JSON.stringify(rows);
  assert.ok(!text.includes("gsk_groq_slot0"), "no key material in a status response");
});

Deno.test("/api/update binds and unbinds a vendor's default model", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch(() => okReply("ok"));
  try {
    const r = await post("/api/update", { provider: "openrouter", model: "google/gemma-4-31b-it:free" });
    assert.deepEqual(await r!.json(), { success: true, provider: "openrouter", model: "google/gemma-4-31b-it:free" });
    await chatCompletions({ model: "openrouter", messages: [{ role: "user", content: "hi" }] });
    assert.equal(RECORDED[0].body.model, "google/gemma-4-31b-it:free", "the binding takes effect immediately, not after a TTL");
    // Unbinding matters: without it a stale override outlives the catalog fix.
    await post("/api/update", { provider: "openrouter", model: null });
    RECORDED.length = 0;
    await chatCompletions({ model: "openrouter", messages: [{ role: "user", content: "hi" }] });
    assert.equal(RECORDED[0].body.model, "nvidia/nemotron-3-super-120b-a12b:free", "back to the catalog default");
    assert.equal((await post("/api/update", { provider: "not-a-vendor", model: "x" }))!.status, 404);
    assert.equal((await post("/api/update", { model: "x" }))!.status, 400);
  } finally { restoreFetch(prev); }
});

Deno.test("/api/reset and /api/reset-stats are different operations again", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  await driveFailures("groq", 2);
  assert.ok(isCooling("groq"));
  assert.ok((await getInstanceRoster()).some((i: any) => i.requests > 0), "there is diagnostic history");
  // /api/reset clears the LIVE routing decision and leaves the history alone.
  const r = await post("/api/reset", {});
  const body = await r!.json();
  assert.equal(body.success, true);
  assert.ok(body.cool.length >= 1, "it reports what it cleared");
  assert.ok(!isCooling("groq"));
  assert.ok((await getInstanceRoster()).some((i: any) => i.requests > 0), "history survives a cooldown reset");
  // /api/reset-stats clears the history.
  await post("/api/reset-stats", {});
  assert.ok((await getInstanceRoster()).every((i: any) => i.requests === 0),
    "reset-stats clears the counters: a genuinely different operation from reset");
});

Deno.test("OMNI_CLIENT_KEYS gates inference but leaves diagnostics open", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OMNI_CLIENT_KEYS: "secret-a,secret-b" });
  const prev = installFetch(() => okReply("ok"));
  try {
    // This was documented in the README from day one and never implemented: a
    // public URL spending its owner's API keys for anyone who found it.
    assert.equal((await post("/v1/chat/completions", { model: "groq", messages: [{ role: "user", content: "hi" }] }))!.status, 401);
    assert.equal((await get("/v1/models"))!.status, 401);
    assert.equal((await get("/health"))!.status, 200, "a browser must still be able to diagnose a gate it just locked itself out of");
    assert.equal((await get("/router"))!.status, 200);
    const ok = await post("/v1/chat/completions", { model: "groq", messages: [{ role: "user", content: "hi" }] }, { headers: { authorization: "Bearer secret-b", "content-type": "application/json" } });
    assert.equal(ok!.status, 200);
    const viaQuery = await routerRoutes(new Request("https://free-ai.val.run/v1/chat/completions?key=secret-a", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "groq", messages: [{ role: "user", content: "hi" }] }),
    }));
    assert.equal(viaQuery!.status, 200, "?key= covers a console fetch that cannot set a header");
  } finally { restoreFetch(prev); }
});

Deno.test("OMNI_ADMIN_KEY gates the mutating routes only, and is off by default", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  assert.equal((await post("/api/update", { provider: "groq", model: "openai/gpt-oss-20b" }))!.status, 200, "unset means open, exactly as before");
  setEnv("OMNI_ADMIN_KEY", "admin-secret");
  assert.equal((await post("/api/update", { provider: "groq", model: "openai/gpt-oss-20b" }))!.status, 401);
  assert.equal((await post("/api/reset", {}))!.status, 401);
  const ok = await post("/api/update", { provider: "groq", model: "openai/gpt-oss-20b" }, { headers: { "x-admin-key": "admin-secret", "content-type": "application/json" } });
  assert.equal(ok!.status, 200, "the matrix UI's X-Admin-Key header is recognised");
  assert.equal((await get("/health"))!.status, 200, "reads stay open");
  const h = await (await get("/health"))!.json();
  assert.equal(h.auth.admin_key, true);
});

Deno.test("/v1/models is cached and bounded, and lists every way to name a model", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  let modelCalls = 0;
  const prev = installFetch((url) => {
    if (url.endsWith("/models")) { modelCalls++; return Response.json({ data: [{ id: "live-one" }] }); }
    return okReply("ok");
  });
  try {
    const first = await (await get("/v1/models"))!.json();
    const callsAfterFirst = modelCalls;
    await get("/v1/models");
    assert.equal(modelCalls, callsAfterFirst, "a second call must not re-fan-out to every provider");
    const ids = first.data.map((d: any) => d.id);
    assert.ok(ids.includes("groq"), "vendor ids");
    assert.ok(ids.includes("openai/gpt-oss-120b"), "catalog model ids, for an OpenAI SDK pointed here");
    assert.ok(ids.includes("groq:live-one"), "namespaced live ids, so a caller can pin vendor+model");
    const refreshed = await (await get("/v1/models?refresh=1"))!.json();
    assert.ok(refreshed.data.length > 0);
    assert.ok(modelCalls > callsAfterFirst, "?refresh=1 forces a re-read");
  } finally { restoreFetch(prev); }
});

Deno.test("a provider that hangs on /models costs its own timeout, not the endpoint", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0", OPENROUTER_API_KEY: "sk-or-free-tier" });
  const prev = installFetch((url) => url.includes("groq") && url.endsWith("/models")
    ? new Promise<Response>(() => {}) // never answers
    : url.endsWith("/models") ? Response.json({ data: [{ id: "or-live" }] }) : okReply("ok"));
  try {
    const t0 = Date.now();
    const res = await (await get("/v1/models"))!.json();
    assert.ok(Date.now() - t0 < 9000, `the endpoint returned in ${Date.now() - t0}ms despite one hung vendor`);
    assert.ok(res.data.some((d: any) => d.id === "openrouter:or-live"), "the healthy vendor still contributed");
  } finally { restoreFetch(prev); }
});

Deno.test("/api/models returns the live list for a keyed provider and explains a keyless one", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch((url) => url.endsWith("/models") ? Response.json({ data: [{ id: "a" }, "b"] }) : okReply());
  try {
    const ok = await (await get("/api/models?provider=groq"))!.json();
    assert.deepEqual(ok.map((m: any) => m.id), ["a", "b"], "string and object rows are both normalised");
    assert.equal((await get("/api/models?provider=openrouter"))!.status, 404);
    assert.equal((await get("/api/models?provider=nope"))!.status, 404);
  } finally { restoreFetch(prev); }
});

Deno.test("/router serves the matrix UI, and it talks to same-origin routes", async () => {
  await reset(ALL_KEYS);
  const res = await get("/router");
  assert.equal(res!.headers.get("content-type"), "text/html");
  const html = await res!.text();
  assert.match(html, /Router Matrix/);
  assert.ok(!/https?:\/\/[a-z.]*val\.run\/(api|health)/.test(html), "the UI must use relative URLs now that it is same-origin with its API");
  assert.match(html, /fetch\('\/api\/providers'\)/);
  // The double-escaping that made these two useless in the browser.
  assert.match(html, /SIZE_RGX = \/\^\(\\d\+/, "the size regex must reach the browser as \\d, not \\\\d");
  assert.match(html, /\\u25A0/, "the bound-model glyph must reach the browser as an escape, not literal text");
});

Deno.test("the matrix UI's three endpoints still carry the field names it reads", async () => {
  // /router is 21kB of markup extracted verbatim from the old router.tsx, and it
  // cannot be type-checked against the API it calls. These are the exact shapes
  // its fetch handlers read: S.providers[i].name / .hasKey / .fallbackModel, an
  // /api/models array of {id} (or {error}, which the UI turns into a fallback
  // row), and POST /api/update answering 401 so the UI can prompt for a key.
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch((url) => url.endsWith("/models")
    ? Response.json({ data: [{ id: "openai/gpt-oss-120b" }] }) : okReply("ok"));
  try {
    const providers = await (await get("/api/providers"))!.json();
    const groq = providers.find((p: any) => p.name === "groq");
    assert.ok(groq, "the UI looks providers up by .name");
    assert.equal(groq.hasKey, true, "the UI gates the model picker on .hasKey");
    assert.equal(typeof groq.fallbackModel, "string", "the UI falls back to .fallbackModel when /api/models errors");
    const keyless = providers.find((p: any) => p.name === "openrouter");
    assert.equal(keyless.hasKey, false);
    assert.equal(typeof keyless.fallbackModel, "string", "even a keyless row needs a fallback id to render");

    const models = await (await get("/api/models?provider=groq"))!.json();
    assert.ok(Array.isArray(models) && models.every((m: any) => typeof m.id === "string"),
      "the UI maps this array straight into rows keyed by .id");

    // The UI's error branch reads `data.error` and substitutes the fallback model.
    const failed = await (await get("/api/models?provider=openrouter"))!.json();
    assert.ok(failed.error, "a keyless provider must answer with {error}, not an empty array");
    assert.equal(typeof failed.fallback, "string", "…and must say what to render instead");

    assert.equal((await post("/api/update", { provider: "groq", model: "openai/gpt-oss-120b" }))!.status, 200);
    setEnv("OMNI_ADMIN_KEY", "admin-secret-value");
    const gated = await post("/api/update", { provider: "groq", model: "openai/gpt-oss-20b" });
    assert.equal(gated!.status, 401, "the UI prompts for a key on exactly this status");
    const withKey = await post("/api/update", { provider: "groq", model: "openai/gpt-oss-20b" },
      { headers: { "x-admin-key": "admin-secret-value", "content-type": "application/json" } });
    assert.equal(withKey!.status, 200, "…and retries with the X-Admin-Key header it prompted for");
  } finally { restoreFetch(prev); }
});

Deno.test("OPTIONS preflight is answered with the methods and headers a client needs", async () => {
  await reset(ALL_KEYS);
  const res = await routerRoutes(new Request("https://free-ai.val.run/v1/chat/completions", { method: "OPTIONS" }));
  assert.equal(res!.status, 204);
  assert.equal(res!.headers.get("access-control-allow-origin"), "*");
  assert.match(res!.headers.get("access-control-allow-methods")!, /POST/);
});

Deno.test("a streaming request gets SSE with provenance in a comment line", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const chunks = ["data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n", "data: [DONE]\n\n"];
  const prev = installFetch(() => new Response(new ReadableStream({
    start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  try {
    const res = await chatCompletionsResponse({ model: "groq", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-omni-provider"), "groq");
    const text = await res.text();
    assert.match(text, /^: omni \{/, "provenance rides in an SSE comment line, which SDKs ignore per spec");
    assert.match(text, /"provider":\{[^}]*"vendor":"groq"/);
    assert.ok(!/"key"/.test(text.split("\n")[0]), "no key material in the provenance line");
    for (const c of chunks) assert.ok(text.includes(c.trim()), `passthrough lost ${c.slice(0, 20)}`);
  } finally { restoreFetch(prev); }
});

Deno.test("the in-process path never builds a Request or re-parses what it just serialised", async () => {
  await reset({ GROQ_API_KEY: "gsk_groq_slot0" });
  const prev = installFetch(() => okReply("ok"));
  let requestsBuilt = 0;
  const RealRequest = globalThis.Request;
  (globalThis as any).Request = class extends RealRequest { constructor(...a: any[]) { super(...(a as [any])); requestsBuilt++; } };
  try {
    await chatCompletions({ model: "groq", messages: [{ role: "user", content: "hi" }] });
    assert.equal(requestsBuilt, 0, "routing the app's own calls through a loopback HTTP hop was pure overhead");
  } finally { (globalThis as any).Request = RealRequest; restoreFetch(prev); }
});

