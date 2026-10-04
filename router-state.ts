// Routing state that must survive isolate recycling: instance cooldowns
// (breaker / 429 / bad key), dead model ids, auto-resolved replacements, and
// the UI's per-vendor model binding. One SELECT per request, write-through.
import { all, run, sql } from "./db.ts";

export type Cooldown = { until: number; reason: string; fails: number };
export type Stat = {
  req: number;
  ok: number;
  fail: number;
  last: number;
  model: string;
  err: string;
};
type State = {
  cool: Record<string, Cooldown>;
  dead: Record<string, number>;
  resolved: Record<string, string>;
  bound: Record<string, string>;
  cap: Record<string, { lim: number; until: number }>;
  tps: Record<string, { v: number; n: number }>;
  capin: Record<string, { lim: number; until: number }>;
  stat: Record<string, Stat>;
};

const MAX_FAILS = 2;
export const COOL = {
  breaker: 2_500,
  rate: 6_000,
  auth: 30_000,
  model: 36_000,
  cap: 90_000,
};

let mem: State = {
  cool: {},
  dead: {},
  resolved: {},
  bound: {},
  cap: {},
  capin: {},
  stat: {},
  tps: {},
};
let loadedAt = 0;

export async function loadState(force = false): Promise<State> {
  if (!force && Date.now() - loadedAt < 2_000) return mem;
  const [st, cfg] = await Promise.all([
    all("omni_state", sql`SELECT key, value FROM omni_state`),
    all(
      "omni_router_config",
      sql`SELECT provider, selected_model FROM omni_router_config`,
    ),
  ]);
  const next: State = {
    cool: {},
    dead: {},
    resolved: {},
    bound: {},
    cap: {},
    capin: {},
    stat: {},
    tps: {},
  };
  if (st.ok) {
    for (const r of st.value as { key: string; value: string }[]) {
      const [kind, ...rest] = r.key.split(":");
      const id = rest.join(":");
      try {
        if (kind === "cool") next.cool[id] = JSON.parse(r.value);
        else if (kind === "dead") next.dead[id] = Number(r.value);
        else if (kind === "resolved") next.resolved[id] = r.value;
        else if (kind === "cap") next.cap[id] = JSON.parse(r.value);
        else if (kind === "stat") next.stat[id] = JSON.parse(r.value);
        else if (kind === "capin") next.capin[id] = JSON.parse(r.value);
        else if (kind === "tps") next.tps[id] = JSON.parse(r.value);
      } catch { /* skip corrupt row */ }
    }
  }
  if (cfg.ok) {
    for (
      const r of cfg.value as { provider: string; selected_model: string }[]
    ) next.bound[r.provider] = r.selected_model;
  }
  mem = next;
  loadedAt = Date.now();
  return mem;
}

const put = (key: string, value: string) =>
  run(
    sql`INSERT INTO omni_state (key, value, ts) VALUES (${key}, ${value}, ${Date.now()})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
  );
const del = (key: string) =>
  run(sql`DELETE FROM omni_state WHERE key = ${key}`);

export const isCool = (name: string) =>
  (mem.cool[name]?.until ?? 0) > Date.now();
export const coolInfo = (name: string): Cooldown | undefined => mem.cool[name];
export const isDead = (vendor: string, model: string) =>
  (mem.dead[`${vendor}:${model}`] ?? 0) > Date.now();
// Per-INSTANCE model death (a key's daily quota for one model). Namespaced with "@" because slot 0's
// instance name equals the vendor name — without the prefix, slot 0's quota would kill the model for every slot.
export const isDeadOn = (instance: string, model: string) =>
  (mem.dead[`@${instance}:${model}`] ?? 0) > Date.now();
export async function markDeadOn(
  instance: string,
  model: string,
  until: number,
) {
  mem.dead[`@${instance}:${model}`] = until;
  await put(`dead:@${instance}:${model}`, String(until));
}
export const resolvedFor = (vendor: string) => mem.resolved[vendor];
export const boundFor = (vendor: string) => mem.bound[vendor];
/** learned per-model output ceiling (from "Limit N" size errors), or Infinity */
export const capFor = (vendor: string, model: string) => {
  const c = mem.cap[`${vendor}:${model}`];
  return c && c.until > Date.now() ? c.lim : Infinity;
};
/** learned per-model INPUT ceiling (ITPM / context) — a tier limit, so it lives 24 h */
/** Learned output throughput per vendor:model (tokens/s, EMA over completions ≥ 64 tokens). Drives the deadline-derived
 *  max_tokens cap: catalog constants (openrouter "30 tps") were cutting every build reply to ~1k tokens. */
export const tpsFor = (vendor: string, model: string): number | undefined =>
  mem.tps[`${vendor}:${model}`]?.v ?? mem.tps[`${vendor}:*`]?.v;
export async function noteTps(
  vendor: string,
  model: string,
  tokens: number,
  ms: number,
) {
  if (!(tokens >= 64) || !(ms > 200)) return;
  const v = tokens / (ms / 1000);
  for (const key of [`${vendor}:${model}`, `${vendor}:*`]) {
    const prev = mem.tps[key];
    const next = prev
      ? { v: prev.v * 0.7 + v * 0.3, n: prev.n + 1 }
      : { v, n: 1 };
    mem.tps[key] = next;
    await put(`tps:${key}`, JSON.stringify(next));
  }
}
export const capInFor = (vendor: string, model: string) => {
  const c = mem.capin[`${vendor}:${model}`] ?? mem.capin[`${vendor}:*`];
  return c && c.until > Date.now() ? c.lim : Infinity;
};
export async function setCapIn(vendor: string, model: string, lim: number) {
  mem.capin[`${vendor}:${model}`] = { lim, until: Date.now() + 24 * 1000 };
  await put(
    `capin:${vendor}:${model}`,
    JSON.stringify(mem.capin[`${vendor}:${model}`]),
  );
}
export async function setCap(vendor: string, model: string, lim: number) {
  mem.cap[`${vendor}:${model}`] = { lim, until: Date.now() + COOL.cap };
  await put(
    `cap:${vendor}:${model}`,
    JSON.stringify(mem.cap[`${vendor}:${model}`]),
  );
}

/** Transient failure: counts toward the breaker; opens after MAX_FAILS. */
export async function noteFailure(name: string, reason: string) {
  const c = mem.cool[name] ?? { until: 0, reason, fails: 0 };
  c.fails++;
  c.reason = reason;
  if (c.fails >= MAX_FAILS) {
    c.until = Date.now() + COOL.breaker;
    c.fails = 0;
  }
  mem.cool[name] = c;
  await put(`cool:${name}`, JSON.stringify(c));
}
/** Hard cooldown for a known duration (429 retry-after, 401/403 key/tier). */
export async function coolFor(name: string, ms: number, reason: string) {
  mem.cool[name] = { until: Date.now() + ms, reason, fails: 0 };
  await put(`cool:${name}`, JSON.stringify(mem.cool[name]));
}
export async function noteSuccess(name: string) {
  if (!mem.cool[name]) return;
  delete mem.cool[name];
  await del(`cool:${name}`);
}
/** Per-instance counters: the only externally checkable evidence that a key slot is actually used. Written every attempt. */
export async function noteStat(
  name: string,
  ok: boolean,
  model: string,
  err = "",
) {
  const s = mem.stat[name] ??
    { req: 0, ok: 0, fail: 0, last: 0, model: "", err: "" };
  s.req++;
  ok ? s.ok++ : s.fail++;
  s.last = Date.now();
  s.model = model;
  s.err = ok ? "" : err.slice(0, 120);
  mem.stat[name] = s;
  await put(`stat:${name}`, JSON.stringify(s));
}
export const statFor = (name: string): Stat | undefined => mem.stat[name];
export async function markDead(
  vendor: string,
  model: string,
  until = Date.now() + COOL.model,
) {
  mem.dead[`${vendor}:${model}`] = until;
  await put(`dead:${vendor}:${model}`, String(until));
}
/** Clear cooldowns (and per-instance model deaths) — admin reset. `name` = instance or vendor; empty = everything. */
export async function resetCooldowns(name = "") {
  const hit = (k: string) =>
    !name || k === name || k.split("#")[0] === name || k.startsWith(name + ":");
  const cool = Object.keys(mem.cool).filter(hit),
    dead = Object.keys(mem.dead).filter((k) =>
      !name || hit(k.replace(/^@/, ""))
    ),
    resolved = Object.keys(mem.resolved).filter(hit);
  for (const k of cool) {
    delete mem.cool[k];
    await del(`cool:${k}`);
  }
  for (const k of dead) {
    delete mem.dead[k];
    await del(`dead:${k}`);
  }
  for (const k of resolved) {
    delete mem.resolved[k];
    await del(`resolved:${k}`);
  } // a junk discovery (whisper, prompt-guard) must not survive a reset
  return { cool, dead, resolved };
}
export async function setResolved(vendor: string, model: string) {
  mem.resolved[vendor] = model;
  await put(`resolved:${vendor}`, model);
}
export async function bindModel(vendor: string, model: string) {
  mem.bound[vendor] = model;
  return run(
    sql`INSERT INTO omni_router_config (provider, selected_model) VALUES (${vendor}, ${model})
                 ON CONFLICT(provider) DO UPDATE SET selected_model = excluded.selected_model`,
  );
}

export async function unbind(vendor: string) {
  delete mem.bound[vendor];
  return run(sql`DELETE FROM omni_router_config WHERE provider = ${vendor}`);
}

/** ms until the first of these instances stops cooling; 0 if any is free now; Infinity if none listed. */
export function soonestCooldown(names: string[]): number {
  const now = Date.now();
  let best = Infinity;
  for (const n of names) {
    const u = mem.cool[n]?.until ?? 0;
    if (u <= now) return 0;
    best = Math.min(best, u - now);
  }
  return best;
}

/** Snapshot for /health and the UI. */
export function stateView() {
  const now = Date.now();
  return {
    cooling: Object.entries(mem.cool).filter(([, c]) => c.until > now).map((
      [name, c],
    ) => ({ name, reason: c.reason, ms_left: c.until - now })),
    dead_models: Object.entries(mem.dead).filter(([, t]) => t > now).map((
      [k],
    ) => k),
    resolved: mem.resolved,
    bound: mem.bound,
    caps: Object.fromEntries(
      Object.entries(mem.cap).filter(([, c]) => c.until > now).map((
        [k, c],
      ) => [k, c.lim]),
    ),
    caps_in: Object.fromEntries(
      Object.entries(mem.capin).filter(([, c]) => c.until > now).map((
        [k, c],
      ) => [k, c.lim]),
    ),
    tps: Object.fromEntries(
      Object.entries(mem.tps).filter(([k]) => !k.endsWith(":*")).map((
        [k, t],
      ) => [k, Math.round(t.v)]),
    ),
    stat: mem.stat,
  };
}