import { getProviderArray } from "./inference-provider.ts";
import { all, initDB, type Row, run, sql } from "./db.ts";

type Provider = Row<"provider">;

const MAX_CONCURRENCY = 3;
const MAX_FAILS = 2;
const BREAK_DURATION_MS = 25_000;
const HARD_TIMEOUT_MS = 120_000;
const INFERENCE_TEMPERATURE = 0.0;

// ============================================================================
// 2. STATE MANAGEMENT (SQLite) & CACHING
// ============================================================================
// omni_router_config is already part of db.ts's shared Schema/DDL — initDB()
// from db.ts creates it (and every other table) idempotently. The local
// CREATE TABLE here was a second, drifting source of truth for the same
// table and has been removed rather than kept "just in case" the two diverge.

async function getSavedModels(): Promise<Record<string, string>> {
  const r = await all(
    "omni_router_config",
    sql`SELECT * FROM omni_router_config`,
  );
  if (!r.ok) {
    console.error("getSavedModels failed:", r.error);
    return {};
  }
  const map: Record<string, string> = {};
  for (const row of r.value) map[row.provider] = row.selected_model;
  return map;
}

let inflight = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ============================================================================
// 3. ENTERPRISE CIRCUIT BREAKER
// ============================================================================
type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";
interface Breaker {
  failCount: number;
  state: BreakerState;
  nextAttempt: number;
}
const breakers = new Map<string, Breaker>();

function getBreaker(name: string): Breaker {
  if (!breakers.has(name)) {
    breakers.set(name, { failCount: 0, state: "CLOSED", nextAttempt: 0 });
  }
  return breakers.get(name)!;
}

function checkBreaker(name: string): boolean {
  const b = getBreaker(name);
  if (b.state === "OPEN" && Date.now() >= b.nextAttempt) {
    b.state = "HALF_OPEN";
  }
  return b.state === "HALF_OPEN" || b.state === "CLOSED";
}

function reportBreaker(name: string, success: boolean) {
  const b = getBreaker(name);
  if (success) {
    b.failCount = 0;
    b.state = "CLOSED";
  } else {
    b.failCount++;
    if (b.failCount >= MAX_FAILS || b.state === "HALF_OPEN") {
      b.state = "OPEN";
      b.nextAttempt = Date.now() + BREAK_DURATION_MS;
      b.failCount = 0;
    }
  }
}

// ============================================================================
// 4. CORE INFERENCE ENGINE
// ============================================================================
async function invokeProvider(
  provider: Provider,
  targetModel: string,
  messages: any[],
  tools?: any[],
  toolChoice?: any,
  temperature: number = 0.0,
  maxTokens: number = 1024000,
) {
  const key = Deno.env.get(provider.keyEnv!)!;
  const url = `${provider.base}/chat/completions`;

  const payload: any = {
    model: targetModel,
    messages,
    temperature: temperature,
    stream: false,
    max_tokens: maxTokens,
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
    if (toolChoice) payload.tool_choice = toolChoice;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const t0 = now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://val.town",
        "X-Title": "Ziggyware-OmniRouter",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}: ${await res.text().catch(() => "Unknown")}`,
      );
    }

    const json = await res.json();
    if (!json.choices?.[0]?.message) throw new Error("Malformed JSON response");

    return {
      message: json.choices[0].message,
      latencyMs: Math.round(now() - t0),
      modelUsed: targetModel,
      provider: provider,
    };
  } catch (e: any) {
    clearTimeout(timeoutId);
    throw new Error(
      e.name === "AbortError" ? "API_STALLED_TIMEOUT" : e.message,
    );
  }
}

async function routeInference(
  messages: any[],
  tools?: any[],
  toolChoice?: any,
  temperature: number = 0.0,
  maxTokens: number = 1024000,
) {
  while (inflight >= MAX_CONCURRENCY) await sleep(10);
  inflight++;

  try {
    const savedModels = await getSavedModels();
    const enabledProviders = getProviderArray()
      .filter((p) => Deno.env.get(p.keyEnv!))
      .sort((a, b) => a.priority - b.priority);

    if (enabledProviders.length === 0) {
      throw new Error("NO_PROVIDERS_CONFIGURED");
    }

    for (const prov of enabledProviders) {
      if (!checkBreaker(prov.name)) continue;
      const targetModel = savedModels[prov.name] || prov.fallbackModel!;

      try {
        const { message, latencyMs, modelUsed, provider } =
          await invokeProvider(
            prov,
            targetModel,
            messages,
            tools,
            toolChoice,
            temperature,
            maxTokens,
          );

        reportBreaker(provider.name, true);

        return { message, provider, model: modelUsed, latencyMs };
      } catch (e: any) {
        reportBreaker(prov.name, false);
        console.warn(
          `[SEVERED] ${prov.name} failed (${e.message}). Routing next...`,
        );
      }
    }
    throw new Error("ALL_PROVIDERS_EXHAUSTED_OR_OPEN");
  } finally {
    inflight--;
  }
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS & Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      },
    });
  }

  const init = await initDB();
  if (!init.ok) {
    return Response.json({ error: `DB init failed: ${init.error}` }, {
      status: 500,
    });
  }

  if (req.method === "GET") {
    if (url.pathname === "/api/providers") {
      const savedModels = await getSavedModels();
      const status = getProviderArray().map((p) => ({
        ...p,
        hasKey: !!Deno.env.get(p.keyEnv!),
        currentModel: savedModels[p.name] || p.fallbackModel,
      })).sort((a, b) => a.priority - b.priority);
      return Response.json(status);
    }

    if (url.pathname === "/api/models") {
      const pName = url.searchParams.get("provider");
      const p = getProviderArray().find((x) => x.name === pName);
      if (!p) {
        return Response.json({ error: "Provider not found" }, { status: 404 });
      }
      const key = Deno.env.get(p.keyEnv!);
      if (!key) {
        return Response.json({ error: "Missing API Key" }, { status: 401 });
      }

      try {
        const res = await fetch(`${p.base}/models`, {
          headers: { "Authorization": `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Response.json(data.data || data);
      } catch (e: any) {
        return Response.json({ error: e.message, fallback: p.fallbackModel }, {
          status: 500,
        });
      }
    }

    return new Response(
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Ziggyware Router Matrix</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
        <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
        <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
        <style>
          body { background-color: #030303; color: #03b4f6; font-family: 'Inter', monospace; background-image: radial-gradient(circle at 50% 0%, #1a1530 0%, #030303 60%); min-height: 100vh; }
          .glass { background: rgba(20, 20, 20, 0.4); backdrop-filter: blur(16px); border: 1px solid rgba(0, 115, 255, 0.08); border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
          .glass-hover:hover { border-color: rgba(0, 115, 255, 0.3); background: rgba(30, 30, 30, 0.6); }
          .scrollbar-hide::-webkit-scrollbar { display: none; }
          .gold-text { background: linear-gradient(to right, #0e20fa, #0927f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          .matrix-cell { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script type="text/babel">
          const { useState, useEffect, useMemo } = React;

          // 1. Lexical Pre-Computation (Browser Safe Arrays)
          const SIZE_RGX = /(\\d+\\.?\\d*)b/i;
          const FAMILY_MAP = [["llama", "llama"], ["qwen", "qwen"], ["mistral", "mistral"], ["gpt", "gpt"], ["claude", "claude"], ["gemini", "gemini"], ["deepseek", "deepseek"], ["phi", "phi"], ["gemma", "gemma"], ["mixtral", "mixtral"], ["yi", "yi"], ["cohere", "cohere"]];
          const TYPE_MAP = [["instruct", "instruct"], ["chat", "chat"], ["vision", "vision"], ["embed", "embedding"], ["coder", "code"], ["math", "math"], ["base", "base"]];

          function parseModelFast(id, provider) {
            const s = id.toLowerCase();
            let family = "other", type = "base";
            for (const [k, v] of FAMILY_MAP) if (s.includes(k)) { family = v; break; }
            for (const [k, v] of TYPE_MAP) if (s.includes(k)) { type = v; break; }
            return { id, provider, family, size: (s.match(SIZE_RGX)?.[1] || "?") + "B", type };
          }

          function App() {
            const [providers, setProviders] = useState([]);
            const [selectedProvider, setSelectedProvider] = useState(null);
            const [models, setModels] = useState([]);
            const [loading, setLoading] = useState(false);
            const [toast, setToast] = useState(null);
            const [filterType, setFilterType] = useState(null);

            useEffect(() => { fetchProviders(); }, []);

            const fetchProviders = async () => {
              const res = await fetch('/api/providers');
              setProviders(await res.json());
            };

            const showToast = (msg, type = "success") => {
              setToast({ msg, type });
              setTimeout(() => setToast(null), 3000);
            }

            const selectProvider = async (p) => {
              setSelectedProvider(p);
              setModels([]);
              setFilterType(null);
              if (!p.hasKey) return;
              
              setLoading(true);
              const res = await fetch(\`/api/models?provider=\${p.name}\`);
              const data = await res.json();
              if (data.error) {
                 showToast("Live fetch failed, using fallbacks.", "error");
                 setModels([{ id: p.fallbackModel, isFallback: true }]);
              } else {
                 setModels(Array.isArray(data) ? data : []);
              }
              setLoading(false);
            };

            const bindModel = async (modelId) => {
              if(!selectedProvider) return;
              await fetch('/api/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: selectedProvider.name, model: modelId })
              });
              showToast(\`\${selectedProvider.name} synchronized to \${modelId}\`);
              fetchProviders(); 
              setSelectedProvider({ ...selectedProvider, currentModel: modelId });
            };

            // Matrix Topology Calculations
            const parsedModels = useMemo(() => {
              if (!selectedProvider) return [];
              return models.map(m => parseModelFast(m.id || m.name || m, selectedProvider.name));
            }, [models, selectedProvider]);

            const availableTypes = useMemo(() => [...new Set(parsedModels.map(m => m.type))].sort(), [parsedModels]);
            const filteredModels = useMemo(() => parsedModels.filter(m => !filterType || m.type === filterType), [parsedModels, filterType]);
            const families = useMemo(() => [...new Set(filteredModels.map(m => m.family))].sort(), [filteredModels]);
            const sizes = useMemo(() => [...new Set(filteredModels.map(m => m.size))].sort((a, b) => parseFloat(a.replace(/[^\\d.]/g, "0")) - parseFloat(b.replace(/[^\\d.]/g, "0"))), [filteredModels]);

            return (
              <div className="max-w-7xl mx-auto p-6 md:p-12">
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 h-[75vh]">
                  
                  {/* Left Sidebar: Providers */}
                  <div className="flex flex-col gap-3 overflow-y-auto pr-2 scrollbar-hide lg:col-span-1">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-sky-500/80 mb-2 pl-2">Matrix Nodes</div>
                    {providers.map(p => (
                      <div 
                        key={p.name} onClick={() => selectProvider(p)}
                        className={\`glass glass-hover p-4 cursor-pointer transition-all duration-300 \${selectedProvider?.name === p.name ? 'ring-1 ring-sky-500/50 bg-sky-950/20 shadow-[0_0_30px_rgba(17,119,256,0.1)]' : ''}\`}
                      >
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-mono text-sm font-semibold tracking-wider text-gray-200 uppercase">{p.name}</span>
                          <span className={\`h-2 w-2 rounded-full \${p.hasKey ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-red-500/50'}\`}></span>
                        </div>
                        <div className="text-[10px] text-sky-500/80 font-mono flex items-center gap-2 truncate">
                          <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                          <span className="truncate">{p.currentModel}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Right Main Pane: Multi-Dimensional Matrix */}
                  <div className="lg:col-span-3 glass flex flex-col overflow-hidden relative">
                    {!selectedProvider ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
                        <svg className="w-20 h-20 mb-6 opacity-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="0.5" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"></path></svg>
                        <p className="font-mono uppercase tracking-[0.3em] text-sm opacity-50">Select a Node to View Topology</p>
                      </div>
                    ) : (
                      <div className="flex flex-col h-full p-8">
                        <div className="mb-6 border-b border-white/5 pb-4 flex justify-between items-end">
                          <div>
                            <h2 className="text-3xl font-light text-white uppercase tracking-wider">{selectedProvider.name}</h2>
                            <p className="text-xs font-mono text-sky-500/40 mt-1">{selectedProvider.base}</p>
                          </div>
                          {availableTypes.length > 0 && (
                            <div className="flex gap-2">
                              {availableTypes.map(t => (
                                <button
                                  key={t} onClick={() => setFilterType(t === filterType ? null : t)}
                                  className={\`px-3 py-1 text-[10px] uppercase tracking-wider border rounded transition-all \${filterType === t ? 'bg-sky-500/20 text-sky-300 border-sky-500 shadow-[0_0_10px_rgba(14,165,233,0.3)]' : 'border-white/10 text-gray-500 hover:border-white/30'}\`}
                                >
                                  {t}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {!selectedProvider.hasKey ? (
                          <div className="flex-1 flex items-center justify-center">
                            <div className="text-center p-8 border border-red-900/30 bg-red-950/10 rounded-xl">
                              <p className="text-red-400/80 font-mono text-sm tracking-wide leading-relaxed">
                                CONNECTION REFUSED.<br/><br/>
                                Inject Key: <span className="text-red-300 font-bold px-2 py-1 bg-red-900/30 rounded mx-1">{selectedProvider.keyEnv}</span>
                              </p>
                            </div>
                          </div>
                        ) : loading ? (
                          <div className="flex-1 flex items-center justify-center">
                            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-l-2 border-sky-500/80"></div>
                          </div>
                        ) : filteredModels.length === 0 ? (
                           <div className="flex-1 flex items-center justify-center text-gray-600 font-mono text-xs uppercase tracking-widest">Topology Empty</div>
                        ) : (
                          <div className="flex-1 overflow-auto scrollbar-hide pr-4">
                            <div className="grid gap-2" style={{ gridTemplateColumns: \`80px repeat(\${sizes.length}, minmax(40px, 1fr))\` }}>
                              {/* Header Row: Sizes */}
                              <div></div>
                              {sizes.map(s => (
                                <div key={s} className="text-[10px] text-center opacity-50 font-mono pb-2 border-b border-white/5">{s}</div>
                              ))}

                              {/* Matrix Rows: Families */}
                              {families.map(f => (
                                <React.Fragment key={f}>
                                  <div className="text-[10px] opacity-70 flex items-center uppercase pr-4 text-sky-200 border-r border-white/5">{f}</div>
                                  {sizes.map(s => {
                                    const m = filteredModels.find(x => x.family === f && x.size === s);
                                    const isActive = m?.id === selectedProvider.currentModel;
                                    return (
                                      <div
                                        key={s}
                                        onClick={() => m && bindModel(m.id)}
                                        title={m?.id}
                                        className={\`matrix-cell h-10 rounded flex flex-col items-center justify-center text-[10px] border \${!m ? 'border-transparent opacity-0 pointer-events-none' : isActive ? 'bg-sky-500/20 border-sky-400 shadow-[0_0_15px_rgba(14,165,233,0.3)] text-sky-300 font-bold cursor-default' : 'bg-black/40 border-white/5 hover:border-white/30 text-gray-500 hover:text-white cursor-pointer'}\`}
                                      >
                                        {m ? (isActive ? "■" : "●") : ""}
                                      </div>
                                    )
                                  })}
                                </React.Fragment>
                              ))}
                            </div>
                            
                            {/* Fallback List for Unmapped Models */}
                            <div className="mt-8 border-t border-white/5 pt-4">
                              <div className="text-[10px] uppercase text-gray-600 mb-2 font-mono">Raw Nomenclature Ledger</div>
                              <div className="flex flex-wrap gap-2">
                                {
                                  filteredModels.map(m => {
                                    const isActive = m.id === selectedProvider.currentModel;
                                    return (
                                      <div key={m.id} onClick={() => bindModel(m.id)} className={\`text-[9px] px-2 py-1 rounded cursor-pointer transition-colors \${isActive ? 'bg-sky-500 text-black font-bold' : 'bg-white/5 text-gray-500 hover:text-white'}\`}>
                                        {m.id}
                                      </div>
                                    )
                                  })
                                }
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {toast && (
                  <div className={\`fixed bottom-8 right-8 px-6 py-4 rounded-xl shadow-2xl backdrop-blur-xl border text-sm font-mono z-50 transition-all duration-500 \${toast.type === 'error' ? 'bg-red-950/80 border-red-900/50 text-red-200' : 'bg-emerald-950/80 border-emerald-900/50 text-emerald-200'}\`}>
                    {toast.msg}
                  </div>
                )}
              </div>
            );
          }

          const root = ReactDOM.createRoot(document.getElementById('root'));
          root.render(<App />);
        </script>
      </body>
      </html>
    `,
      { headers: { "Content-Type": "text/html" } },
    );
  } else if (req.method === "POST") {
    if (url.pathname === "/api/update") {
      const { provider, model } = await req.json();
      const r = await run(
        sql`INSERT INTO omni_router_config (provider, selected_model)
            VALUES (${provider}, ${model})
            ON CONFLICT(provider)
              DO UPDATE SET selected_model = excluded.selected_model`,
      );
      if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
      return Response.json({ success: true });
    }

    try {
      const body = await req.json();
      const messages = body.messages ||
        (body.prompt ? [{ role: "user", content: body.prompt }] : []);
      if (!messages.length) {
        return new Response(
          JSON.stringify({ error: "Empty message payload" }),
          { status: 400 },
        );
      }
      const { message, provider, model, latencyMs } = await routeInference(
        messages,
        body.tools,
        body.tool_choice,
        INFERENCE_TEMPERATURE,
      );

      const activeGuards = getProviderArray()
        .filter((p) => Deno.env.get(p.keyEnv!))
        .map((p) => ({ name: p.name, state: getBreaker(p.name).state }));

      const sseId = `chatcmpl-omni-${crypto.randomUUID()}`;

      if (body.stream) {
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          start(controller) {
            const sendChunk = (
              delta: any,
              finish_reason: string | null = null,
            ) => {
              controller.enqueue(encoder.encode(`data: ${
                JSON.stringify({
                  id: sseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta, finish_reason }],
                })
              }\n\n`));
            };

            sendChunk({ role: "assistant", content: "" });
            if (message.content) sendChunk({ content: message.content });
            if (message.tool_calls) {
              sendChunk({ tool_calls: message.tool_calls });
            }
            sendChunk({}, message.tool_calls ? "tool_calls" : "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response(
        JSON.stringify({
          id: sseId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          }],
          _omni_meta: {
            provider: provider,
            latency_ms: latencyMs,
            inflight_requests: inflight,
            circuit_states: activeGuards,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: { message: "(error).", details: e.message } }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  }

  return new Response("Not Found", { status: 404 });
}