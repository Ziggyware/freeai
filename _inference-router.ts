import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { getProviderArray } from "./inference-provider.ts";
import type { Provider } from "./db.ts";

// ============================================================================
// 2. STATE MANAGEMENT (SQLite) & CACHING
// ============================================================================
async function initDB() {
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS omni_router_config (
      provider TEXT PRIMARY KEY,
      selected_model TEXT NOT NULL
    )
  `);
}

async function getSavedModels(): Promise<Record<string, string>> {
  const result = await sqlite.execute(
    `SELECT provider, selected_model FROM omni_router_config`,
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    const r = row as any;
    map[r.provider as string] = r.selected_model as string;
  }
  return map;
}

const MAX_CONCURRENCY = 3;
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
const MAX_FAILS = 2;
const BREAK_DURATION_MS = 25_000;
const HARD_TIMEOUT_MS = 12_000;

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
  return b.state === "HALF_OPEN" ||
    b.state === "CLOSED";
}

function reportBreaker(name: string, success: boolean) {
  const b = getBreaker(name);
  if (success) {
    b.failCount = 0;
    b.state = "CLOSED";
  } else {
    b.failCount++;
    if (
      b.failCount >= MAX_FAILS ||
      b.state === "HALF_OPEN"
    ) {
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
) {
  const key = Deno.env.get(provider.keyEnv)!;
  const url = `${provider.base}/chat/completions`;

  const payload: any = {
    model: targetModel,
    messages,
    temperature: 0.0,
    stream: false,
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
) {
  while (inflight >= MAX_CONCURRENCY) await sleep(10);
  inflight++;

  try {
    const savedModels = await getSavedModels();
    const enabledProviders = getProviderArray();

    if (enabledProviders.length === 0) {
      throw new Error("NO_PROVIDERS_CONFIGURED");
    }

    for (const provider of enabledProviders) {
      if (!checkBreaker(provider.name)) continue;
      const targetModel = savedModels[provider.name] ||
        provider.fallbackModel;

      try {
        const {
          message,
          latencyMs,
          modelUsed,
        } = await invokeProvider(
          provider,
          targetModel,
          messages,
          tools,
          toolChoice,
        );

        reportBreaker(provider.name, true);

        const resultPayload = {
          message,
          provider: provider,
          model: modelUsed,
          latencyMs,
        };

        return resultPayload;
      } catch (e: any) {
        reportBreaker(provider.name, false);
        console.warn(
          `[SEVERED] ${provider.name} failed (${e.message}). Routing next...`,
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

  // Ensure DB
  await initDB();
  if (req.method === "GET") {
    // --- API: Get Status ---
    if (url.pathname === "/api/providers") {
      const savedModels = await getSavedModels();
      const status = getProviderArray().map((p) => ({
        ...p,
        hasKey: !!Deno.env.get(p.keyEnv),
        currentModel: savedModels[p.name] || p.fallbackModel,
      })).sort((a, b) => a.priority - b.priority);
      return Response.json(status);
    }

    // --- API: Proxy Fetch Models ---
    if (url.pathname === "/api/models") {
      const pName = url.searchParams.get("provider");
      const p = getProviderArray().find((x) => x.name === pName);
      if (!p) {
        return Response.json({ error: "Provider not found" }, { status: 404 });
      }

      const key = Deno.env.get(p.keyEnv);
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
      } catch (e) {
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
        <title>Ziggyware AI Chat</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
        <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
        <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
        <style>
          body { background-color: #030303; color: #03b4f6; font-family: 'Inter', sans-serif; background-image: radial-gradient(circle at 50% 0%, #1a1530 0%, #030303 60%); min-height: 100vh; }
          .glass { background: rgba(20, 20, 20, 0.4); backdrop-filter: blur(16px); border: 1px solid rgba(0, 115, 255, 0.08); border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
          .glass-hover:hover { border-color: rgba(0, 115, 255, 0.3); background: rgba(30, 30, 30, 0.6); }
          .scrollbar-hide::-webkit-scrollbar { display: none; }
          .gold-text { background: linear-gradient(to right, #0e20fa, #0927f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script type="text/babel">
          const { useState, useEffect } = React;

          function App() {
            const [providers, setProviders] = useState([]);
            const [selectedProvider, setSelectedProvider] = useState(null);
            const [models, setModels] = useState([]);
            const [loading, setLoading] = useState(false);
            const [toast, setToast] = useState(null);

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

            return (
              <div className="max-w-7xl mx-auto p-6 md:p-12">
                
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-[70vh]">
                  
                  
                  <div className="flex flex-col gap-3 overflow-y-auto pr-2 scrollbar-hide">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-sky-500/80 mb-2 pl-2">Default Model</div>
                    {providers.map(p => (
                      <div 
                        key={p.name} onClick={() => selectProvider(p)}
                        className={\`glass glass-hover p-5 cursor-pointer transition-all duration-300 \${selectedProvider?.name === p.name ? 'ring-1 ring-sky-500/50 bg-sky-950/20 shadow-[0_0_30px_rgba(17,119,256,0.1)]' : ''}\`}
                      >
                        <div className="flex justify-between items-center mb-3">
                          <span className="font-mono text-sm font-semibold tracking-wider text-gray-200 uppercase">{p.name}</span>
                          <span className={\`h-2 w-2 rounded-full \${p.hasKey ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-red-500/50'}\`}></span>
                        </div>
                        <div className="text-xs text-sky-500/80 font-mono flex items-center gap-2 truncate">
                          <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                          <span className="truncate">{p.currentModel}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  
                  <div className="lg:col-span-2 glass flex flex-col overflow-hidden relative">
                    {!selectedProvider ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
                        <svg className="w-20 h-20 mb-6 opacity-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="0.5" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"></path></svg>
                        <p className="font-mono uppercase tracking-[0.3em] text-sm opacity-50">Awaiting Selection</p>
                      </div>
                    ) : (
                      <div className="flex flex-col h-full p-8">
                        <div className="mb-8 border-b border-white/5 pb-6">
                          <h2 className="text-3xl font-light text-white uppercase tracking-wider">{selectedProvider.name}</h2>
                          <div className="flex items-center justify-between mt-2">
                            <p className="text-xs font-mono text-sky-500/40">{selectedProvider.base}</p>
                            <span className="text-xs font-mono px-2 py-1 bg-white/5 rounded text-gray-400">PRIORITY: {selectedProvider.priority}</span>
                          </div>
                        </div>

                        {!selectedProvider.hasKey ? (
                          <div className="flex-1 flex items-center justify-center">
                            <div className="text-center p-8 border border-red-900/30 bg-red-950/10 rounded-xl">
                              <p className="text-red-400/80 font-mono text-sm tracking-wide leading-relaxed">
                                NOT CONFIGURED.<br/><br/>
                                <span className="text-red-300 font-bold px-2 py-1 bg-red-900/30 rounded mx-1">{selectedProvider.keyEnv}</span><br/>.
                              </p>
                            </div>
                          </div>
                        ) : loading ? (
                          <div className="flex-1 flex items-center justify-center">
                            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-l-2 border-sky-500/80"></div>
                          </div>
                        ) : (
                          <div className="flex-1 overflow-y-auto pr-4 scrollbar-hide">
                            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                              {models.map((m, i) => {
                                const mId = m.id || m.name || m;
                                const isActive = mId === selectedProvider.currentModel;
                                return (
                                  <div key={i} className={\`p-4 rounded-xl border flex justify-between items-center transition-all duration-300 \${isActive ? 'bg-sky-500/10 border-sky-500/40 shadow-[0_0_15px_rgba(17,119,256,0.1)]' : 'bg-black/40 border-white/5 hover:border-white/20'}\`}>
                                    <div className="truncate pr-4 font-mono text-sm text-gray-300">{mId}</div>
                                    {!isActive ? (
                                      <button onClick={() => bindModel(mId)} className="text-[10px] px-4 py-2 rounded-lg bg-white/5 hover:bg-sky-500 hover:text-black transition-colors uppercase font-bold tracking-widest flex-shrink-0">
                                        Bind
                                      </button>
                                    ) : (
                                      <span className="text-[10px] text-sky-500 font-bold uppercase tracking-widest flex-shrink-0 px-2">Active</span>
                                    )}
                                  </div>
                                )
                              })}
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
    // --- API: Update SQLite DB ---
    if (url.pathname === "/api/update") {
      const { provider, model } = await req.json();
      await sqlite.execute({
        sql:
          `INSERT INTO omni_router_config (provider, selected_model) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET selected_model = excluded.selected_model`,
        args: [provider, model],
      });
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
      );

      const activeGuards = getProviderArray()
        .filter((p) => Deno.env.get(p.keyEnv))
        .map(
          (p) => ({ name: p.name, state: getBreaker(p.name).state }),
        );

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
                  _omni_meta: {
                    provider: JSON.stringify(provider),
                    latency_ms: latencyMs,
                    inflight_requests: inflight,
                    circuit_states: activeGuards,
                  },
                })
              }\n\n`));
            };

            // 1. Role chunk
            sendChunk({ role: "assistant", content: "" });

            // 2. Content chunk
            if (message.content) sendChunk({ content: message.content });

            // 3. Tools chunk
            if (message.tool_calls) {
              sendChunk({ tool_calls: message.tool_calls });
            }

            // 4. Finish chunk
            sendChunk({}, message.tool_calls ? "tool_calls" : "stop");

            // 5. End Stream
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
        JSON.stringify({
          error: {
            message: "(error).",
            details: e.message,
          },
        }),
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