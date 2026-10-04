// ─────────────────────────────────────────────────────────────
// REST API — /api/respond
// Stateless wrapper around Cortex.respond()
// ─────────────────────────────────────────────────────────────

import { Cortex } from "./db2.ts";

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { session, input } = await req.json();

    const result = await Cortex.respond(session, input);

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    const result = await Cortex.respond("", "");

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }
}