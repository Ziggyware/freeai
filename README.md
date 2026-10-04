# free-ai

A free AI that **builds applications**. You describe an app; it plans the files, writes them, heals the seams (module tags, missing exports, TypeScript-in-JS), and serves a runnable artifact at `/artifact/<id>/`.

The scheduled pipeline is `design → plan → build (one file per step) → integrate → verify → conform`. Builds survive a closed tab. `/build …` forces a build; `/fix` repairs the open artifact.

It is also an **OpenAI-compatible router over 28 model vendors**, mounted in this same app — no separate deployment, no HTTP hop between a chat turn and its providers. `GET /router` is a live matrix of every vendor, its key slots, its bound model and its cooldown state.

## The router

One decision, in one place: **which provider answers next.**

A request names a `model`. That is either a *meta-model* (`auto`, `best`, `fast`), a *capability tag* (`coder`, `reasoning`, `long`, `vision`), a *vendor* (`groq`), a *key slot* (`groq#1`), a *vendor pin* (`groq:openai/gpt-oss-120b`) or a bare *upstream id* (`openai/gpt-oss-120b`). The router turns it into a ranked candidate list, then walks it — one bounded attempt each — until something answers.

Candidates are ordered by, in priority order:

1. **Ready before cooling.** An instance in cooldown sorts last but is never dropped: a total-outage request should still try *something*.
2. **Tier: `free` → `credit` → `paid`.** A paid vendor never outranks a ready free one, whatever the model quality. `credit` is a finite balance (a trial, a prepaid credit) and ranks after a recurring free tier but before metered billing.
3. **Tag match**, when the caller asked for one. Untagged instances stay in the list, at the tail — a tag degrades rather than 404s.
4. **The mode's objective.** `fast` ranks on the estimated time to a *complete* reply (`ttft + expected_tokens / tps`), not on throughput alone: a 1200 tok/s vendor with a 400 ms first token beats a 30 tok/s one with a 4 s first token only when the reply is short enough. Everything else ranks on a catalog quality prior.
5. **Measured health.** Laplace-smoothed success rate from `provider_stats`, decayed toward neutral with age, so a vendor broken for a week and since fixed is not exiled forever.
6. Catalog rank, then key slot.

Then **vendor round-robin** interleaves the result, so five key slots of one vendor cannot consume a budget that only funds three attempts.

Nothing is called that cannot answer. An instance is skipped *without spending an attempt* when: the caller excluded it, its secret is malformed, its live model chain is empty, or the prompt exceeds its input ceiling. Skips are reported back in `skipped[]` with the reason — the difference between "the router is broken" and "your prompt is 9k tokens and the widest vendor takes 6.5k".

## Call it

```ts
import { omni } from "https://esm.town/v/ziggyware/free-ai/omni-client.ts";
const r = await omni.chat([{ role: "user", content: "hi" }], { model: "coder" });
for await (const tok of omni.stream(msgs)) process.stdout.write(tok);
```

Or any OpenAI SDK with `baseURL: "https://<this-val>/v1"`. Provenance comes back in `_omni_meta` (JSON) and `X-Omni-Provider` / `X-Omni-Model` headers, in both streaming and non-streaming modes; in a stream it rides in an SSE comment line, which SDKs ignore per spec.

From inside the app, `chatCompletions(body)` is a plain async function — no `Request` is constructed and no JSON is re-parsed.

## `model` field

| value | routes to |
|---|---|
| `auto` / `best` / empty | every configured instance, best model first |
| `fast` | every configured instance, by estimated time to a complete reply |
| `coder` `reasoning` `long` `vision` | tagged vendors first, then the rest at the tail |
| `groq` | that vendor's instances (all key slots) |
| `groq#1` | exactly one key slot |
| `groq:openai/gpt-oss-120b` or `groq/openai/gpt-oss-120b` | that vendor, forced upstream id |
| `openai/gpt-oss-120b` | **every** vendor that serves that id |
| `nvidia/nemotron-…:free` | OpenRouter's free roster, not the NVIDIA vendor |

Unknown values → **404 with the accepted values attached**, never silently rerouted. A caller asking for `gpt-4-turbo` gets told what exists rather than getting an answer from a model it did not ask for.

`nvidia` is deliberately spelled `nvidia_nim` as a vendor id: OpenRouter's free roster is full of `nvidia/*` model ids, and a vendor named `nvidia` would swallow every one of them.

All standard OpenAI params pass through (`tools`, `tool_choice`, `response_format`, `temperature`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `stop`, `top_p`, `seed`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `n`, `user`, …). Reasoning models (gpt-oss, qwen3.x) spend `max_tokens` on thinking first — send ≥256 or `reasoning_effort: "low"`, or you get `finish_reason: "length"` with empty content. The router floors its own clamp at 256 for that reason, and a reply carrying `reasoning` is treated as truncated rather than empty.

`max_tokens` is clamped per vendor to `min(asked, vendor output cap, vendor TPM − prompt tokens)`, and goes out under whichever field name the caller used — `gpt-5` rejects `max_tokens` outright. `tool_choice: "none"` suppresses the `tools` array, which Groq rejects as a combination.

## Keys

Every vendor in `providers.ts` declares its `keyEnv`. Each may be suffixed `1`–`9` (`GROQ_API_KEY`, `GROQ_API_KEY1`, …), and any one of them may hold a comma-separated list. **Every key becomes its own instance** (`groq`, `groq#1`, …) with its own cooldown, its own success record and its own slice of the rotation.

A comma is only treated as a separator when *every* part looks like a key. A secret holding a pasted JSON fragment (`aiza…3, }`) is reported whole rather than split into a plausible-looking truncated key plus a junk sibling — a truncated key produces a 401 from the vendor and a "provider auth failure" in the logs, three layers from its actual cause.

`cloudflare` also needs `CF_ACCOUNT_ID`; it is interpolated into the base URL, and a missing var surfaces as a key issue naming the variable instead of an `Invalid URL` at fetch time.

`pollinations` needs no key at all, so a deployment with zero secrets configured still answers.

| env | effect |
|---|---|
| `OMNI_PROVIDERS` | JSON array of vendor rows merged by `vendor` — add a vendor (needs `base` + `models[]`) or override `models`/`priority`/`base`/`tags` |
| `OMNI_DISABLE` | `vendor,vendor` to skip |
| `OMNI_QUALITY` | `{"regex":score}` — override/add the 0–100 quality priors used by `auto` |
| `OMNI_CLIENT_KEYS` | `k1,k2` — gates `/v1/*` and the chat endpoints. Unset means open. `/health`, `/router` and `/api/providers` stay readable so you can diagnose a gate you just locked yourself out of |
| `OMNI_ADMIN_KEY` | gates the three mutating routes (`/api/update`, `/api/reset`, `/api/reset-stats`) |
| `OMNI_MAX_CONCURRENCY` | admission slots, default 4. Excess requests queue FIFO and the wait is charged to the caller's deadline |
| `OMNI_STREAM_IDLE_MS` | cut a stream silent for this long, default the hard router timeout |
| `OMNI_URL` | this app's public URL, for error messages and the client default |
| `OMNI_ROUTER_ALLOW` | extra hostnames a saved `routerUrl` may point at (`.val.run` is allowed by suffix) |

Keys are accepted as `Authorization: Bearer …`, `X-Admin-Key: …`, `?key=` or `?admin_key=` — the last two cover a console `fetch` that cannot set a header.

## Failure policy

Failures are classified once, in one place, because three different failures used to wear one message: the right response to "add credit", "wait eight seconds" and "your own deadline accounting ran out" is not the same.

| upstream | router action | cooldown |
|---|---|---|
| 401 / 403 | next candidate; never retried inside the call | 60 s — hammering an auth failure is how an account gets flagged |
| 429 with `retry-after` | next candidate | **the header's value**, floored at 8 s |
| 429 mentioning a daily quota, or 402 | next candidate | 1 h — a per-day cap does not reset in eight seconds |
| 404 naming a model id | next id in that vendor's own list, then live discovery | 1 h on that `(instance, model)` and `(vendor, model)` |
| 400 naming a parameter | drop exactly that parameter, retry the same model **once** | none — the request was at fault, not the vendor |
| 400/413 about size | next candidate | learns the real input ceiling, so the next oversized prompt is skipped, not sent |
| 5xx / timeout / network | next candidate | breaker opens after 2 consecutive strikes, 3 s |
| 200 with an empty or dots-only body | next candidate | counted as a strike |
| 200 with an error body | next candidate | counted as a strike |

A `404`-for-model or a dropped parameter never cools the *instance*: the vendor is fine, the request was not.

Cooldowns, learned ceilings and discovered model ids persist in `omni_state`; usage counters in `provider_stats`; saved model bindings in `omni_router_config`. All survive isolate recycling. State is re-read at most once per 5 s, in three parallel queries, single-flighted, and a failed read is never cached. Ordinary reloads **merge** cooldowns (many isolates share one database, and replacing would drop a cooldown this isolate observed a second ago); a forced reload — `invalidateState()`, or the reset button — **replaces**, because merging there would keep exactly the entries the operator asked to be rid of.

### The budget is the real constraint

`timing.ts` fixes the arithmetic: a 13.5 s grant with ≥3 candidates yields **4.5 s per candidate**, so roughly three providers are funded per call. `perCallMax` sits at its invariant ceiling (`perCallMax + returnReserve ≤ chatTurnBudget`). Ordering quality, not attempt count, is therefore the lever — which is why the ranking above is strict about tier and health rather than optimistic about walking a 28-vendor roster.

Within a call the router also retries *inside* one vendor before moving on: up to 3 model ids on a `model` failure, one parameter repair on a `param` failure, and one live-discovery shot if the remaining time can fund it.

The app-side client (`app-infer.ts`) adds one more layer: on a `413 PROMPT_TOO_LARGE` it shrinks the message history and retries **immediately** rather than resending an identical oversized prompt four times. That branch used to be dead code — it matched on a message format the router never produced, so every size-exhausted request burned its whole wall clock failing identically.

## Routes

Mounted by `app.tsx` ahead of its own dispatch. Every app route is query-parameter based (`?q`, `?plan`, `?build_file`, …) and every router route is pathname based, so the two cannot collide; the one shared path, `POST /`, is claimed by the router only when it carries no query string at all.

**Inference** — `POST /v1/chat/completions` (also `/chat/completions` and bare `/`), streaming and not.

**Reads** — `GET /health` · `GET /v1/models` (also `/models`; `?refresh=1` forces a re-read) · `GET /api/providers` · `GET /api/models?provider=` · `GET /router` (matrix UI).

**Writes** (gated by `OMNI_ADMIN_KEY` when set) — `POST /api/update {provider, model}` binds a vendor's default model, `model: null` unbinds · `POST /api/reset` clears cooldowns, learned ceilings and discovered ids, and reports what it cleared · `POST /api/reset-stats` clears the `provider_stats` history.

`/api/reset` and `/api/reset-stats` are deliberately separate: clearing a stuck cooldown should not also erase the evidence that it was stuck.

`OPTIONS` is answered with a 204 and permissive CORS headers on every router path, so a browser-based OpenAI client can preflight.

## Layout

| file | what it is |
|---|---|
| `providers.ts` | the catalog: 28 vendor rows, key-slot expansion, quality priors, prompt/token maths, `model` resolution |
| `router.ts` | the engine: durable state, cooldowns, ranking, discovery, the attempt loop, `routeChat()` |
| `router-api.ts` | the protocols on top: the OpenAI contract (function + HTTP) and the routes `app.tsx` mounts |
| `ui-router.ts` | the `/router` matrix UI |
| `app-infer.ts` | the app's own inference client: budgeting, size-bound retries, deadline handling |
| `timing.ts` | the shared budget arithmetic and its invariants |

Adding a vendor is one row in `providers.ts`. Rank is `(priority ?? tier default) * 1000 + declaration order`, so `priority` is only ever a tie-break.

These replaced nine files (`router.tsx`, `router-core.ts`, `router-openai.ts`, `router-state.ts`, `router-discover.ts`, `catalog.ts`, `catalog-free.ts`, `catalog-paid.ts`, `inference-provider.ts`) that described one decision between them — two of which had stopped typechecking against the others, and one of which was a second deployment the app could not actually reach over HTTP.
