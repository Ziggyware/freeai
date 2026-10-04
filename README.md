# free-ai

A free AI that **builds applications**. You describe an app; it plans the files, writes them, heals the seams (module tags, missing exports, TypeScript-in-JS), and serves a runnable artifact at `/artifact/<id>/`.

The scheduled pipeline is `design → plan → build (one file per step) → integrate → verify → conform`. Builds survive a closed tab. `/build …` forces a build; `/fix` repairs the open artifact.

It is also an OpenAI-compatible router that fans out across every configured provider with per-instance circuit breaking, model-level fallback, and live model discovery. Endpoint: `https://router.val.run`.

## Call it

```ts
import { omni } from "https://esm.town/v/ziggyware/free-ai/omni-client.ts";
const r = await omni.chat([{ role: "user", content: "hi" }], { model: "coder" });
for await (const tok of omni.stream(msgs)) process.stdout.write(tok);
```

Or any OpenAI SDK with `baseURL: "https://router.val.run/v1"`. Provenance comes back in `_omni_meta` (JSON) and `X-Omni-Provider` / `X-Omni-Model` headers (both modes).

## `model` field

| value | routes to |
|---|---|
| `auto` / `best` / empty | every free instance, **best model first** (catalog `QUALITY` prior; ties → vendor priority) |
| `fast` | every instance in vendor priority (latency) order, catalog model order |
| `coder` `reasoning` `long` `vision` | tagged vendors first, quality-ranked; `coder` boosts ids matching /coder/ |
| `groq` | that vendor's instances (all keys) |
| `groq#1` | one key slot |
| `groq:openai/gpt-oss-120b` or `groq/openai/gpt-oss-120b` | that vendor, forced upstream id |

Unknown values → 404, never silently rerouted.

All standard OpenAI params pass through (`tools`, `tool_choice`, `response_format`, `temperature`, `max_tokens`, `reasoning_effort`, `stop`, `top_p`, `seed`, …). Reasoning models (gpt-oss, qwen3.x) spend `max_tokens` on thinking first — send ≥256 or `reasoning_effort: "low"`, or you get `finish_reason: "length"` with empty content.

## Keys (env / secrets)

For each vendor's `keyEnv` (see `catalog-free.ts`, `catalog-paid.ts`): `GROQ_API_KEY`, `GROQ_API_KEY1` … `GROQ_API_KEY9`, and any of those may hold `k1,k2,k3`. Every key becomes an instance (`groq`, `groq#1`, …) with its own cooldown. `cloudflare` also needs `CF_ACCOUNT_ID`.

| env | effect |
|---|---|
| `OMNI_PROVIDERS` | JSON array of vendor rows, merged by `vendor` — add a vendor or override `models`/`priority`/`base` |
| `OMNI_DISABLE` | `vendor,vendor` to skip |
| `OMNI_QUALITY` | `{"regex":score}` — override/add quality scores (0–100) used by `auto` |
| `OMNI_CLIENT_KEYS` | `k1,k2` — when set, callers must send `Authorization: Bearer k` (or `?key=`); `/` and `/health` stay open |

## Failure policy

| upstream | action |
|---|---|
| 404 / model-not-found / tier-not-allowed | mark that model dead 1 h, try next model; after the list, pick from live `/models` by the vendor's `prefer` regex and remember it |
| 413 / "Request too large" / "Limit N, Requested M" | shrink `max_tokens` to fit and retry the same model; an output ceiling ("OTPM", "max_tokens") is remembered 15 min per model (`caps` in `/health`) |
| 429 | cool the instance for `Retry-After` (≤15 min) or 60 s |
| 401 / 403 | cool the instance 1 h |
| 5xx / timeout (120 s) / network | breaker: 2 strikes → 25 s |

After the first pass over every vendor, the router retries up to 2 more rounds — immediately for transient failures, or after waiting for the soonest cooldown when that fits the deadline. With `omni_deadline_ms` set, a vendor that cannot finish in the time left is skipped while a faster one is queued, and `max_tokens` is capped to what the vendor can stream before the deadline (a `finish_reason: "length"` reply beats a timeout — the client continues it).

State lives in `omni_state` (SQLite) so it survives isolate recycling. `GET /health` shows what is cooling, dead, resolved, and capped.

## Routes

`GET /health` · `GET /v1/models` · `GET /api/providers` · `GET /api/models?provider=` · `POST /v1/chat/completions` (also `/`, `/chat/completions`) · `POST /api/update {provider, model}` binds a vendor's default · `GET /` matrix UI.
