// ─────────────────────────────────────────────────────────────
// WEBSOCKET STREAMING API — /ws
// Streams Cortex output chunk-by-chunk
// ─────────────────────────────────────────────────────────────

import { UniversalStreaming } from "./db2.ts";

export function handleWebSocket(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onmessage = async (ev) => {
    const { session, input } = JSON.parse(ev.data);

    for await (const chunk of UniversalStreaming.respond(session, input)) {
      socket.send(JSON.stringify({ chunk }));
    }

    socket.send(JSON.stringify({ done: true }));
  };

  return response;
}