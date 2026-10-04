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
| Provider error (including 4xx/5xx) | Try the next configured instance in order; an unknown requested model is returned as 404 |
| Prompt too large | The app client trims history and retries with a smaller prompt, while its deadline can still fund another routed call |
| 429 / timeout / network | Try the next instance; the app may retry the route if enough time remains |
| Deadline or admission queue exhausted | Stop when another minimum attempt cannot fit; return 503 with attempted and skipped providers |

With a caller deadline, routing divides the remaining wall-clock across up to three candidates instead of letting the first slow provider consume the whole grant. Each per-provider slice covers headers and the complete non-streaming response body; fast failures free their unused time for more candidates. Admission-queue waits are cancelled at the same deadline. Larger visual/app builds (including 3D scenes, shaders, and star fields) use the durable design → plan → one-file-at-a-time build pipeline, progressing in small bounded steps rather than one oversized response.

Provider usage counters live in `provider_stats`, and saved model bindings in `omni_router_config`; both survive isolate recycling. `GET /health` reports configured instances and their request/success/failure counts.

## Routes

`GET /health` · `GET /v1/models` · `GET /api/providers` · `GET /api/models?provider=` · `POST /v1/chat/completions` (also `/`, `/chat/completions`) · `POST /api/update {provider, model}` binds a vendor's default · `GET /` matrix UI.
