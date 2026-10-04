// Conversation compaction: a running summary of everything older than the last few exchanges, stored per session in
// omni_state (key compact:<session>) and prepended to the model context in place of the messages it covers. Messages
// themselves are never deleted — history rendering is unchanged — only what the model sees is folded.
// Runs as its own val invocation (POST ?compact) so it never competes with a turn's 60 s budget.
import { all, run, sql, unwrap } from "./db.ts";
import { clientStatusFor } from "./app-boundary.ts";
import { readJsonBody } from "./app-helpers.ts";
import { renderPrompt } from "./prompts.ts";
import { normalizeSettings, type Settings } from "./app-settings.ts";

export type Compact = { summary: string; uptoId: number; ts: number; covered: number; chars: number };

export async function loadCompact(session: string): Promise<Compact | null> {
  const rows = unwrap(await all<"omni_state">("omni_state", sql`SELECT value FROM omni_state WHERE key = ${"compact:" + session}`), []);
  try { return rows[0] ? JSON.parse(rows[0].value) as Compact : null; } catch { return null; }
}
export async function saveCompact(session: string, c: Compact | null): Promise<void> {
  const key = "compact:" + session;
  if (!c) { await run(sql`DELETE FROM omni_state WHERE key = ${key}`); return; }
  await run(sql`INSERT INTO omni_state (key, value, ts) VALUES (${key}, ${JSON.stringify(c)}, ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`);
}

/** Chars of live (uncompacted) history — what a turn would have to fit. */
export async function liveChars(session: string, uptoId: number): Promise<{ chars: number; count: number }> {
  const rows = unwrap(await all<"message">("message", sql`SELECT id, content FROM message WHERE session = ${session} AND id > ${uptoId} ORDER BY id DESC LIMIT 200`), []);
  return { chars: rows.reduce((n, r) => n + r.content.length, 0), count: rows.length };
}

const KEEP_TAIL = 6; // the last 3 exchanges are never folded: the model needs them verbatim

/** Fold everything older than the last KEEP_TAIL messages into the summary. `call` is the inference function (fast tier). */
export async function compactSession(
  session: string,
  call: (messages: unknown[]) => Promise<string>,
  prompts?: Record<string, string>,
  examples = true,
): Promise<{ ok: boolean; before: number; after: number; covered: number; uptoId: number; reason?: string }> {
  const prev = await loadCompact(session);
  const uptoPrev = prev?.uptoId ?? 0;
  const rows = unwrap(await all<"message">("message", sql`SELECT * FROM message WHERE session = ${session} AND id > ${uptoPrev} ORDER BY id ASC`), []);
  // Was `<= KEEP_TAIL + 1`: at rows.length === KEEP_TAIL+1 there is already exactly one row old enough
  // to fold (rows.length - KEEP_TAIL === 1), so the +1 rejected a foldable state as "nothing old enough"
  // and delayed the first compaction by one message past the intended KEEP_TAIL threshold.
  if (rows.length <= KEEP_TAIL) return { ok: false, before: 0, after: prev?.chars ?? 0, covered: 0, uptoId: uptoPrev, reason: "nothing old enough to fold" };
  const fold = rows.slice(0, rows.length - KEEP_TAIL);
  const before = fold.reduce((n, r) => n + r.content.length, 0);
  const transcript = fold.map((m) => `[#${m.id} ${m.role}] ${m.content.length > 5_000 ? m.content.slice(0, 3_800) + "\n…[" + (m.content.length - 4_800) + " chars trimmed]…\n" + m.content.slice(-1_000) : m.content}`).join("\n\n");
  const prompt = renderPrompt("compact", { previous: prev?.summary ?? "(none — this is the first compaction)", transcript }, prompts as any, examples);
  const summary = (await call([{ role: "system", content: "You maintain the running summary of a long working conversation. Output only the summary." }, { role: "user", content: prompt }])).trim();
  if (summary.length < 80) return { ok: false, before, after: prev?.chars ?? 0, covered: 0, uptoId: uptoPrev, reason: "model returned no usable summary" };
  const storedSummary = summary.slice(0, 12_000);
  // chars must reflect what's actually stored (storedSummary), not the pre-truncation raw model output —
  // getContext() seeds its context-budget accounting with this value, so a mismatch here silently
  // over-reserves budget on every turn after a summary that ran past the 12,000-char cap.
  const next: Compact = { summary: storedSummary, uptoId: fold[fold.length - 1].id, ts: Date.now(), covered: (prev?.covered ?? 0) + fold.length, chars: storedSummary.length };
  await saveCompact(session, next);
  return { ok: true, before, after: next.chars, covered: fold.length, uptoId: next.uptoId };
}

/** The system message a turn prepends when a compaction exists. */
export function compactMessage(c: Compact): { role: "system"; content: string } {
  return { role: "system", content: `CONVERSATION SO FAR (compacted summary of ${c.covered} earlier messages; treat as established context, do not repeat it back):\n${c.summary}` };
}

/** HTTP: POST ?compact {session, settings} folds old turns; GET ?compact=<session> reads the summary; DELETE clears it. Null when not a compact route. */
export async function handleCompact(req: Request, url: URL, infer: (messages: unknown[], settings: Settings) => Promise<string>): Promise<Response | null> {
  if (!url.searchParams.has("compact")) return null;
  const session = url.searchParams.get("compact") || "";
  if (req.method === "GET") {
    const c = await loadCompact(session); const budget = Number(url.searchParams.get("check")) || 0;
    const live = budget ? await liveChars(session, c?.uptoId ?? 0) : null;
    return Response.json({ compact: c, needs: !!live && live.count > 8 && live.chars > 2 * budget, live });
  }
  if (req.method === "DELETE") { await saveCompact(session, null); return Response.json({ ok: true }); }
  if (req.method !== "POST") return null;
  const b = await readJsonBody(req);
  const settings = normalizeSettings(b.settings ?? {});
  const s = String(b.session ?? "");
  if (!s) return Response.json({ error: { message: "session required" } }, { status: 400 });
  try { return Response.json(await compactSession(s, (m) => infer(m, settings), settings.prompts as Record<string, string>, settings.examples)); }
  catch (e: any) { return Response.json({ error: { message: `compact failed: ${String(e?.message ?? e).slice(0, 300)}` } }, { status: clientStatusFor(e) }); }
}
