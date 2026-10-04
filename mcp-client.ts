import { T } from "./timing.ts";
// ════════════════════════════════════════════════════════════════════════════
//  MCP CLIENT — Streamable HTTP transport, zero dependencies.
//
//  Connects this app's agent loop to Model Context Protocol servers and
//  surfaces their tools alongside the built-in registry. The first (and
//  motivating) server is `rojs`, the local Roslyn C# analysis sidecar: its
//  MCP bridge is `mcp-server.mjs` in the rojs repo, run with `--http` so it
//  speaks Streamable HTTP on http://localhost:5081/mcp.
//
//  Deployment note: this code runs server-side (Val Town / Deno). From the
//  Val Town cloud, "localhost" is the val's own sandbox — to reach a rojs
//  instance on your machine you must tunnel it (e.g. `cloudflared tunnel
//  --url http://localhost:5081`) and set:
//    ROJS_MCP_URL   = https://<tunnel-host>/mcp
//    ROJS_MCP_TOKEN = <same value as the bridge's ROJS_MCP_TOKEN>
//  Running the app locally under plain Deno, the default localhost URL works
//  as-is. Additional servers: MCP_SERVERS = JSON array of
//    {"name":"...", "url":"https://.../mcp", "token":"..."}.
//
//  Failure posture: MCP servers are OPTIONAL capability, never a dependency.
//  Discovery has a short timeout and a negative-result cache, so an offline
//  sidecar costs one failed fetch per minute, not one per message.
// ════════════════════════════════════════════════════════════════════════════

export interface McpServerConfig {
  name: string;
  url: string;
  token?: string;
}

// Structural twin of app.tsx's Tool — declared here rather than imported so
// the dependency points app → mcp-client only.
export interface McpTool {
  schema: Record<string, unknown>;
  handle: (
    args: Record<string, unknown>,
    ctx: { session: string },
  ) => Promise<unknown>;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const DISCOVER_TIMEOUT_MS = 3_000; // a turn must not stall on a dead sidecar
// Was a private 30_000 — the last timeout in the system that still outlived the budget it runs inside.
// A tool call happens WITHIN a turn or a step, and timing.ts caps a tool at toolMax; a 30s private copy
// meant a single MCP call could outlast the whole step that issued it by 16 seconds, with the lease
// lapsing underneath it. Same number, one place, asserted at load like every other.
const CALL_TIMEOUT_MS = T.toolMax;
const CACHE_TTL_MS = 60_000;

// ── Config ────────────────────────────────────────────────────────────────────

function env(key: string): string | undefined {
  try {
    return Deno.env.get(key) ?? undefined;
  } catch {
    return undefined; // no --allow-env for this var; treat as unset
  }
}

export function mcpServerConfigs(): McpServerConfig[] {
  const servers: McpServerConfig[] = [];
  const raw = env("MCP_SERVERS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const s of parsed) {
          if (s && typeof s.name === "string" && typeof s.url === "string") {
            servers.push({ name: s.name, url: s.url, token: s.token });
          }
        }
      }
    } catch {
      console.warn("MCP_SERVERS is not valid JSON; ignoring.");
    }
  }
  // rojs is wired in by default: absent config it points at the local bridge,
  // and simply fails discovery (cheaply) when the bridge isn't running.
  if (!servers.some((s) => s.name === "rojs")) {
    servers.push({
      name: "rojs",
      url: env("ROJS_MCP_URL") ?? "http://localhost:5081/mcp",
      token: env("ROJS_MCP_TOKEN"),
    });
  }
  return servers;
}

// ── Wire protocol ─────────────────────────────────────────────────────────────

class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;
  private cfg: McpServerConfig;

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      // Spec requires the client to accept both response modes even though
      // we only ever get one message back per POST.
      "accept": "application/json, text/event-stream",
    };
    if (this.cfg.token) h["authorization"] = `Bearer ${this.cfg.token}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  // POST one JSON-RPC message; return the parsed response (or null for a
  // notification's 202). Handles both application/json and text/event-stream
  // response bodies, since Streamable HTTP servers may use either.
  private async post(
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202) {
      await res.body?.cancel();
      return null;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${this.cfg.name} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      // Minimal SSE parse: each event's data lines are one JSON-RPC message;
      // the response to our request is the one carrying our id.
      const id = (payload as { id?: unknown }).id;
      // Per the SSE spec, a blank line (event boundary) is any of \n\n, \r\n\r\n, or \r\r — splitting on
      // "\n\n" alone silently mis-parses (or entirely misses) events from a server that sends CRLF line
      // endings, since "\r\n\r\n" doesn't contain a literal "\n\n" substring in a way this split expects
      // consistently once \r sticks to the preceding line. Normalize line endings before splitting instead.
      for (const chunk of text.replace(/\r\n/g, "\n").split("\n\n")) {
        const data = chunk.split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg && msg.id === id) return msg;
        } catch { /* keep-alives, non-JSON events */ }
      }
      throw new Error(`${this.cfg.name}: no response for id ${id} in SSE stream`);
    }
    return text ? JSON.parse(text) : null;
  }

  private async rpc(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const msg = await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) },
      timeoutMs,
    );
    if (!msg) throw new Error(`${this.cfg.name}: empty response to ${method}`);
    const err = msg.error as { code?: number; message?: string } | undefined;
    if (err) throw new Error(`${this.cfg.name} ${method}: ${err.message ?? "error"}`);
    return msg.result;
  }

  private async ensureInit(timeoutMs: number): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "freeai-chat", version: "1.0.0" },
    }, timeoutMs);
    // Notification: no id, expect 202/no body.
    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      timeoutMs,
    );
    this.initialized = true;
  }

  async listTools(timeoutMs = DISCOVER_TIMEOUT_MS): Promise<McpToolDef[]> {
    await this.ensureInit(timeoutMs);
    const r = (await this.rpc("tools/list", undefined, timeoutMs)) as {
      tools?: McpToolDef[];
    };
    return r?.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensureInit(DISCOVER_TIMEOUT_MS);
    const r = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (r?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (r?.isError) return { error: text || "tool error" };
    // Tool outputs are JSON-serialized by convention; fall back to raw text.
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // A failed session (network flap, server restart) must not poison the
  // client forever — drop protocol state so the next call re-initializes.
  reset(): void {
    this.initialized = false;
    this.sessionId = null;
  }
}

// Clients persist across discovery cycles so MCP session state (and the
// initialize handshake) isn't redone per chat message.
const clients = new Map<string, McpClient>();

function clientFor(cfg: McpServerConfig): McpClient {
  let c = clients.get(cfg.name);
  if (!c) {
    c = new McpClient(cfg);
    clients.set(cfg.name, c);
  }
  return c;
}

// ── Tool registry ─────────────────────────────────────────────────────────────

// OpenAI function-name charset; MCP tool names are looser.
function toolKey(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

let cache: { at: number; tools: Record<string, McpTool> } | null = null;

/**
 * Discover tools from every configured MCP server. Cached for CACHE_TTL_MS —
 * including negative results, so an offline server is retried once a minute
 * rather than once a message. Never throws.
 */
export async function discoverMcpTools(): Promise<Record<string, McpTool>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.tools;

  const tools: Record<string, McpTool> = {};
  await Promise.all(mcpServerConfigs().map(async (cfg) => {
    const client = clientFor(cfg);
    let defs: McpToolDef[];
    try {
      defs = await client.listTools();
    } catch (e) {
      client.reset();
      console.warn(`MCP server "${cfg.name}" unavailable: ${String(e).slice(0, 160)}`);
      return;
    }
    for (const def of defs) {
      const key = toolKey(cfg.name, def.name);
      tools[key] = {
        schema: {
          type: "function",
          function: {
            name: key,
            description: def.description ?? `${cfg.name}: ${def.name}`,
            parameters: def.inputSchema ?? { type: "object", properties: {} },
          },
        },
        handle: async (args) => {
          try {
            return await client.callTool(def.name, args);
          } catch (e) {
            client.reset();
            return { error: String(e) };
          }
        },
      };
    }
  }));

  cache = { at: now, tools };
  return tools;
}