import { getCatalogStatus, getProviderArray, type ProviderInstance } from "./inference-provider.ts";
import { installRejectionBackstop, withBoundary } from "./app-boundary.ts";
import { initDB, run, sql } from "./db.ts";
import { getInstanceRoster, getSavedModels, inflight, resetProviderStats } from "./router-core.ts";
import { handleChatCompletions } from "./router-openai.ts";

const CORS = { "Access-Control-Allow-Origin": "*" };
const OPENAI_PATHS = new Set(["/", "/chat/completions", "/v1/chat/completions"]);
// Item 3: /api/update, /api/reset and /api/reset-stats are all reachable, unauthenticated, on a publicly
// known URL — confirmed exploitable this session (the user's own successful unauthenticated POST to
// /api/update). Gating them behind OMNI_ADMIN_KEY is opt-in and backward-compatible: unset, every mutating
// route behaves exactly as before (this is a real, live router the user is actively depending on — a
// gate that broke it by default the moment this code shipped would be worse than the hole it closes).
// Once set, callers must send it back as `X-Admin-Key` (or `?admin_key=`, for the plain-fetch snippets
// this session already handed the user from a browser console with no header-setting ceremony).
const ADMIN_KEY = Deno.env.get("OMNI_ADMIN_KEY") || "";
function isAdmin(req: Request, url: URL): boolean {
  if (!ADMIN_KEY) return true; // gate is off unless explicitly configured
  // ui-settings.ts already has a "router key" field (s.routerKey) that it sends as `Authorization: Bearer
  // <key>` on /health and /api/reset — plumbing that pre-dated any server-side check actually reading it.
  // Recognizing that header here means the existing settings field starts working with zero UI changes.
  // X-Admin-Key / ?admin_key= are accepted too, for the plain-fetch console snippets this session already
  // handed the user, which don't bother constructing an Authorization header.
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const supplied = bearer || req.headers.get("x-admin-key") || url.searchParams.get("admin_key") || "";
  return supplied === ADMIN_KEY;
}

async function listUpstreamModels(p: ProviderInstance): Promise<unknown> {
  const headers: Record<string, string> = p.key ? { "Authorization": `Bearer ${p.key}` } : {};
  const res = await fetch(`${p.base}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.data || data;
}

/** Same boundary guarantee as app.tsx: always answer before Val Town's ~60s kill, so a slow route
 *  surfaces as a readable 503 instead of a Cloudflare "Bad gateway" page with nothing behind it. */
export { RESPONSE_DEADLINE_MS } from "./app-boundary.ts";

installRejectionBackstop();
export default withBoundary(handleRouterRequest, { label: "ROUTER" });

async function handleRouterRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

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
    if (url.pathname === "/health") {
      const live = getProviderArray();
      // instances/key_policy/auth: the settings panel's "test / status" table (ui-settings.ts routerStatus())
      // reads exactly this shape — it was previously missing entirely, so the table always rendered zero rows
      // regardless of how many providers were actually configured.
      const keyIssues = live.filter((p) => p.keyIssue).map((p) => ({ instance: p.name, env: p.keyEnv, issue: p.keyIssue }));
      return Response.json({
        status: live.length > 0 ? (keyIssues.length ? "ok-with-key-issues" : "ok") : "degraded",
        providers_configured: live.length,
        inflight_requests: inflight,
        key_issues: keyIssues, // top-level, not buried per-instance: a malformed secret is the single most common "why is X never working" answer
        key_policy: "tiered:top+1retry,siblings,breadth;config-dead→tail", // see orderTargets() + demotion in router-core.ts
        auth: !!ADMIN_KEY, // true once OMNI_ADMIN_KEY is set — gates /api/update, /api/reset, /api/reset-stats
        instances: await getInstanceRoster(),
      });
    }

    if (url.pathname === "/api/providers") {
      const savedModels = await getSavedModels();
      return Response.json(getCatalogStatus().map((p) => ({
        ...p,
        currentModel: savedModels[p.name] || p.fallbackModel,
      })));
    }

    if (url.pathname === "/api/models") {
      const pName = url.searchParams.get("provider");
      const p = getProviderArray().find((x) => x.name === pName);
      if (!p) return Response.json({ error: "Provider not found or no key" }, { status: 404 });
      try {
        return Response.json(await listUpstreamModels(p));
      } catch (e: any) {
        return Response.json({ error: e.message, fallback: p.fallbackModel }, { status: 502 });
      }
    }

    // OpenAI-style aggregate list: one row per routable instance (its bound
    // model) plus every upstream id namespaced "<vendor>:<id>", so a client can
    // pin vendor+model through the `model` field of chat.completions.
    if (url.pathname === "/v1/models") {
      const live = getProviderArray();
      const saved = await getSavedModels();
      const seen = new Set<string>();
      const rows: Record<string, unknown>[] = [];
      for (const p of live) {
        const base = p.name.split("#")[0];
        for (const id of [base, p.vendor]) {
          if (seen.has(id)) continue;
          seen.add(id);
          rows.push({ id, object: "model", owned_by: p.vendor, bound: saved[base] || p.fallbackModel });
        }
      }
      const results = await Promise.all(
        live.filter((p) => p.slot === 0).map(async (p) => {
          try {
            const list = await listUpstreamModels(p);
            return Array.isArray(list)
              ? list.map((m: any) => `${p.vendor}:${typeof m === "string" ? m : m.id}`)
              : [];
          } catch {
            return [];
          }
        }),
      );
      for (const id of results.flat()) {
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, object: "model", owned_by: id.split(":")[0] });
      }
      return Response.json({ object: "list", data: rows });
    }

    return new Response(
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
        <title>Ziggyware Router Matrix</title>
        <style>
          :root { --bg:#030303; --fg:#03b4f6; --line:rgba(255,255,255,.06); }
          * { box-sizing: border-box; }
          body { background:var(--bg); color:var(--fg); font-family:'Inter',ui-monospace,SFMono-Regular,Menlo,monospace;
                 background-image:radial-gradient(circle at 50% 0%, #1a1530 0%, #030303 60%); min-height:100vh; margin:0; }
          .wrap { max-width:80rem; margin:0 auto; padding:12px 12px 96px; }
          .brand { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.2em; color:rgba(14,165,233,.8); margin-bottom:12px; }
          .glass { background:rgba(20,20,20,.4); backdrop-filter:blur(16px); border:1px solid rgba(0,115,255,.08);
                   border-radius:16px; box-shadow:0 10px 40px rgba(0,0,0,.5); }
          .glass:hover { border-color:rgba(0,115,255,.3); background:rgba(30,30,30,.6); }
          .noscroll::-webkit-scrollbar { display:none; }
          .noscroll { scrollbar-width:none; }
          .cols { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:24px; }
          .plist { grid-column:span 1; display:flex; flex-direction:column; gap:8px; max-height:70vh; overflow-y:auto; padding-right:8px; }
          .main { grid-column:span 3; }
          .pcard { padding:12px; border-radius:12px; cursor:pointer; border:1px solid var(--line); transition:border-color .2s,background .2s; }
          .pcard.on { border-color:rgba(14,165,233,.6); background:rgba(8,47,73,.2); }
          .pcard .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
          .pcard .nm { font-size:14px; font-weight:600; color:#e5e7eb; text-transform:uppercase; }
          .pcard .cm { font-size:10px; color:rgba(14,165,233,.8); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .dot { height:8px; width:8px; border-radius:50%; display:inline-block; }
          .dot.ok { background:#10b981; } .dot.no { background:rgba(239,68,68,.5); }
          .chips { display:flex; gap:8px; overflow-x:auto; padding-bottom:12px; margin-bottom:12px; scroll-snap-type:x mandatory; }
          .chip { scroll-snap-align:start; flex-shrink:0; padding:8px 16px; border-radius:8px; border:1px solid rgba(255,255,255,.1);
                  font-size:12px; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; color:#9ca3af; background:transparent; cursor:pointer; }
          .chip.on { border-color:#0ea5e9; background:rgba(8,47,73,.4); color:#7dd3fc; }
          .chip .dot { margin-right:8px; height:6px; width:6px; }
          .pane { display:flex; flex-direction:column; border-radius:16px; border:1px solid var(--line); padding:16px; }
          .phead { margin-bottom:16px; border-bottom:1px solid var(--line); padding-bottom:12px;
                   display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-end; gap:8px; }
          .phead h2 { font-size:22px; font-weight:300; color:#fff; text-transform:uppercase; letter-spacing:.025em; margin:0; }
          .phead .base { font-size:10px; color:rgba(14,165,233,.4); margin-top:2px; word-break:break-all; }
          .vf { display:flex; gap:6px; flex-wrap:wrap; }
          .vf button { padding:4px 10px; font-size:10px; text-transform:uppercase; letter-spacing:.025em;
                       border:1px solid rgba(255,255,255,.1); border-radius:4px; color:#6b7280; background:transparent; cursor:pointer; }
          .vf button.on { background:rgba(14,165,233,.2); color:#7dd3fc; border-color:#0ea5e9; }
          .nokey { text-align:center; padding:24px; border:1px solid rgba(127,29,29,.3); background:rgba(69,10,10,.1); border-radius:12px; }
          .nokey p { color:rgba(248,113,113,.8); font-size:12px; letter-spacing:.025em; line-height:1.6; margin:0; }
          .nokey span { color:#fca5a5; font-weight:700; padding:2px 6px; background:rgba(127,29,29,.3); border-radius:4px; }
          .spin { margin:64px auto; height:40px; width:40px; border-radius:50%;
                  border-top:2px solid rgba(14,165,233,.8); border-left:2px solid rgba(14,165,233,.8);
                  border-right:2px solid transparent; border-bottom:2px solid transparent; animation:sp 1s linear infinite; }
          @keyframes sp { to { transform:rotate(360deg); } }
          .empty { text-align:center; color:#4b5563; font-size:12px; text-transform:uppercase; letter-spacing:.1em; padding:64px 0; }
          .mwrap { overflow:auto; max-height:50vh; border:1px solid var(--line); border-radius:8px; }
          .matrix { display:grid; gap:4px; padding:8px; min-width:max-content; }
          .hdr { font-size:10px; text-align:center; opacity:.6; padding-bottom:6px; border-bottom:1px solid var(--line);
                 position:sticky; top:0; background:#0a0a0a; }
          .fam { font-size:10px; opacity:.7; display:flex; align-items:center; text-transform:uppercase; padding-right:8px;
                 color:#bae6fd; border-right:1px solid var(--line); position:sticky; left:0; background:#0a0a0a;
                 overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .cell { height:40px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:10px;
                  border:1px solid var(--line); background:rgba(0,0,0,.4); color:#6b7280; cursor:pointer; transition:all .2s cubic-bezier(.4,0,.2,1); }
          .cell.gap { border-color:transparent; background:transparent; opacity:0; pointer-events:none; cursor:default; }
          .cell.act { background:rgba(14,165,233,.2); border-color:#38bdf8; color:#7dd3fc; font-weight:700; }
          .cell.ins { background:rgba(255,255,255,.1); border-color:rgba(255,255,255,.4); color:#fff; }
          .insp { margin-top:12px; min-height:52px; border-radius:8px; border:1px solid var(--line); padding:12px;
                  display:flex; align-items:center; justify-content:space-between; gap:12px; }
          .insp .id { font-size:12px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .insp .meta { font-size:10px; color:#6b7280; margin-top:2px; }
          .insp .hint { font-size:10px; color:#4b5563; text-transform:uppercase; letter-spacing:.05em; }
          .bind { flex-shrink:0; padding:6px 12px; font-size:10px; text-transform:uppercase; letter-spacing:.025em;
                  background:#0ea5e9; color:#000; font-weight:700; border:0; border-radius:4px; cursor:pointer; }
          .toast { position:fixed; bottom:16px; left:12px; right:12px; padding:12px 20px; border-radius:12px;
                   border:1px solid; font-size:14px; z-index:50; }
          .toast.ok { background:rgba(2,44,34,.9); border-color:rgba(6,78,59,.5); color:#a7f3d0; }
          .toast.err { background:rgba(69,10,10,.9); border-color:rgba(127,29,29,.5); color:#fecaca; }
          .hide { display:none; }
          @media (min-width:768px) {
            .wrap { padding:32px 32px 96px; }
            .pane { padding:24px; }
            .toast { left:auto; right:32px; bottom:32px; }
          }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script>
          'use strict';
          // ------------------------------------------------------------
          // MODEL NAME PARSER (token-based, no "other" bucket)
          // Splits id on / @ : - _ . , strips size and known variant
          // tokens, uses remaining tokens as family. Opaque/hashy ids
          // fall back to the raw id as family rather than "other" so
          // grouping stays meaningful instead of mislabeled.
          // ------------------------------------------------------------
          var SIZE_RGX = /^(\\d+(?:\\.\\d+)?)([bmk])$/i;
          var VARIANT_TOKENS = new Set([
            'instruct','chat','vision','embed','embedding','coder','code',
            'math','base','it','preview','beta','free','thinking','reasoning',
            'distill','distilled','turbo','mini','nano','flash','lite','pro',
            'max','ultra','exp','experimental'
          ]);
          var QUANT_RGX = /^(fp16|fp8|bf16|int8|int4|q\\d(_\\w+)?|awq|gptq|gguf)$/i;

          function tokenize(id) {
            return id.toLowerCase().split(/[/@:]/).flatMap(function (seg) { return seg.split(/[-_.]/); }).filter(Boolean);
          }

          function parseModel(rawId, provider) {
            var id = String(rawId);
            var tokens = tokenize(id);
            var size = '?B';
            var variants = [];
            var identityTokens = [];
            for (var i = 0; i < tokens.length; i++) {
              var tok = tokens[i];
              var sizeMatch = tok.match(SIZE_RGX);
              if (sizeMatch) { size = sizeMatch[1] + sizeMatch[2].toUpperCase(); continue; }
              if (QUANT_RGX.test(tok)) continue;
              if (VARIANT_TOKENS.has(tok)) { variants.push(tok); continue; }
              identityTokens.push(tok);
            }
            if (identityTokens.length > 1 && identityTokens[0] === provider.toLowerCase()) identityTokens.shift();
            var family = identityTokens.length > 0 ? identityTokens.join('-') : id.toLowerCase();
            return { id: id, provider: provider, family: family, size: size, variants: variants };
          }

          // ------------------------------------------------------------
          // Rendering is string-built and re-run wholesale on each state
          // change. The page is small enough that a diffing layer would
          // cost more than it saves, and building it this way is what
          // lets the whole admin UI ship with no remote script and no
          // in-browser compiler.
          // ------------------------------------------------------------
          var S = {
            providers: [], sel: null, raw: [], loading: false,
            variant: null, inspect: null, toast: null,
            mobile: window.innerWidth < 768
          };
          var root = document.getElementById('root');
          var toastTimer = null;

          function esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
              return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
          }

          function showToast(msg, type) {
            S.toast = { msg: msg, type: type || 'ok' };
            render();
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = setTimeout(function () { S.toast = null; render(); }, 3000);
          }

          function parsedModels() {
            if (!S.sel) return [];
            return S.raw.map(function (m) { return parseModel(m.id || m.name || m, S.sel.name); });
          }
          function uniq(a) { return Array.from(new Set(a)); }

          function derive() {
            var parsed = parsedModels();
            var variants = uniq(parsed.flatMap(function (m) { return m.variants; })).sort();
            var models = parsed.filter(function (m) { return !S.variant || m.variants.indexOf(S.variant) !== -1; });
            var families = uniq(models.map(function (m) { return m.family; })).sort();
            var sizes = uniq(models.map(function (m) { return m.size; })).sort(function (a, b) {
              return parseFloat(a.replace(/[^\\d.]/g, '0')) - parseFloat(b.replace(/[^\\d.]/g, '0'));
            });
            return { variants: variants, models: models, families: families, sizes: sizes };
          }

          function paneHtml(d) {
            if (!S.sel) return '<div class="empty">Select a provider</div>';
            var h = '<div class="pane glass">';
            h += '<div class="phead"><div><h2>' + esc(S.sel.name) + '</h2>'
               + '<p class="base">' + esc(S.sel.base) + '</p></div>';
            if (d.variants.length) {
              h += '<div class="vf">';
              for (var i = 0; i < d.variants.length; i++) {
                var v = d.variants[i];
                h += '<button data-variant="' + esc(v) + '" class="' + (S.variant === v ? 'on' : '') + '">' + esc(v) + '</button>';
              }
              h += '</div>';
            }
            h += '</div>';

            if (!S.sel.hasKey) {
              h += '<div class="nokey"><p>CONNECTION REFUSED.<br>Inject Key: <span>' + esc(S.sel.keyEnv) + '</span></p></div></div>';
              return h;
            }
            if (S.loading) return h + '<div class="spin"></div></div>';
            if (!d.models.length) return h + '<div class="empty">No models</div></div>';

            var cols = S.mobile
              ? '88px repeat(' + d.sizes.length + ', 56px)'
              : '100px repeat(' + d.sizes.length + ', minmax(48px, 1fr))';
            h += '<div class="mwrap noscroll"><div class="matrix" style="grid-template-columns:' + cols + '"><div></div>';
            for (var s = 0; s < d.sizes.length; s++) h += '<div class="hdr">' + esc(d.sizes[s]) + '</div>';
            for (var f = 0; f < d.families.length; f++) {
              var fam = d.families[f];
              h += '<div class="fam">' + esc(fam) + '</div>';
              for (var j = 0; j < d.sizes.length; j++) {
                var size = d.sizes[j];
                var m = null;
                for (var k = 0; k < d.models.length; k++) {
                  if (d.models[k].family === fam && d.models[k].size === size) { m = d.models[k]; break; }
                }
                if (!m) { h += '<div class="cell gap"></div>'; continue; }
                var active = m.id === S.sel.currentModel;
                var cls = 'cell' + (active ? ' act' : (m.id === S.inspect ? ' ins' : ''));
                h += '<div class="' + cls + '" data-model="' + esc(m.id) + '">' + (active ? '\\u25A0' : '\\u25CF') + '</div>';
              }
            }
            h += '</div></div>';

            var ins = null;
            for (var q = 0; q < d.models.length; q++) if (d.models[q].id === S.inspect) { ins = d.models[q]; break; }
            h += '<div class="insp">';
            if (ins) {
              h += '<div style="min-width:0"><div class="id">' + esc(ins.id) + '</div><div class="meta">family: '
                 + esc(ins.family) + ' \\u00B7 size: ' + esc(ins.size)
                 + (ins.variants.length ? ' \\u00B7 ' + esc(ins.variants.join(', ')) : '')
                 + '</div></div><button class="bind" data-bind="' + esc(ins.id) + '">Bind</button>';
            } else {
              h += '<span class="hint">Tap a cell to inspect</span>';
            }
            return h + '</div></div>';
          }

          function render() {
            var d = derive();
            var pane = paneHtml(d);
            var h = '<div class="wrap"><div class="brand">Ziggyware Router Matrix</div>';
            if (S.mobile) {
              h += '<div class="chips noscroll">';
              for (var i = 0; i < S.providers.length; i++) {
                var p = S.providers[i];
                h += '<button class="chip ' + (S.sel && S.sel.name === p.name ? 'on' : '') + '" data-provider="' + esc(p.name) + '">'
                   + '<span class="dot ' + (p.hasKey ? 'ok' : 'no') + '"></span>' + esc(p.name) + '</button>';
              }
              h += '</div>' + pane;
            } else {
              h += '<div class="cols"><div class="plist noscroll">';
              for (var j = 0; j < S.providers.length; j++) {
                var q = S.providers[j];
                h += '<div class="pcard glass ' + (S.sel && S.sel.name === q.name ? 'on' : '') + '" data-provider="' + esc(q.name) + '">'
                   + '<div class="top"><span class="nm">' + esc(q.name) + '</span>'
                   + '<span class="dot ' + (q.hasKey ? 'ok' : 'no') + '"></span></div>'
                   + '<div class="cm">' + esc(q.currentModel) + '</div></div>';
              }
              h += '</div><div class="main">' + pane + '</div></div>';
            }
            if (S.toast) h += '<div class="toast ' + (S.toast.type === 'error' ? 'err' : 'ok') + '">' + esc(S.toast.msg) + '</div>';
            root.innerHTML = h + '</div>';
          }

          async function fetchProviders() {
            var res = await fetch('/api/providers');
            S.providers = await res.json();
            render();
          }

          async function selectProvider(name) {
            var p = null;
            for (var i = 0; i < S.providers.length; i++) if (S.providers[i].name === name) { p = S.providers[i]; break; }
            if (!p) return;
            S.sel = p; S.raw = []; S.variant = null; S.inspect = null;
            if (!p.hasKey) { render(); return; }
            S.loading = true; render();
            try {
              var res = await fetch('/api/models?provider=' + encodeURIComponent(p.name));
              var data = await res.json();
              if (data && data.error) {
                S.raw = [{ id: p.fallbackModel, isFallback: true }];
                S.loading = false;
                showToast('Live fetch failed, using fallback.', 'error');
                return;
              }
              S.raw = Array.isArray(data) ? data : [];
            } catch (e) {
              S.raw = [{ id: p.fallbackModel, isFallback: true }];
              S.loading = false;
              showToast('Live fetch failed, using fallback.', 'error');
              return;
            }
            S.loading = false; render();
          }

          // OMNI_ADMIN_KEY is opt-in, but once someone DOES set it, this Bind button would otherwise
          // silently 401 with no indication why - it never sent any credential. So: try unauthenticated
          // first (matching today's default-off behavior exactly), and only prompt on a 401, caching the
          // key in localStorage so it is asked once per browser rather than once per Bind click.
          async function bindModel(modelId) {
            if (!S.sel) return;
            var doBind = function (key) {
              var headers = { 'Content-Type': 'application/json' };
              if (key) headers['X-Admin-Key'] = key;
              return fetch('/api/update', {
                method: 'POST', headers: headers,
                body: JSON.stringify({ provider: S.sel.name, model: modelId })
              });
            };
            var key = '';
            try { key = localStorage.getItem('omni_admin_key') || ''; } catch (e) { key = ''; }
            var res = await doBind(key);
            if (res.status === 401) {
              key = window.prompt('This router requires an admin key to bind models (OMNI_ADMIN_KEY). Enter it:') || '';
              if (!key) { showToast('Bind cancelled - admin key required', 'error'); return; }
              res = await doBind(key);
              if (res.status === 401) { showToast('Bind failed - wrong admin key', 'error'); return; }
              try { localStorage.setItem('omni_admin_key', key); } catch (e) { /* private mode: ask again next time */ }
            }
            if (!res.ok) { showToast('Bind failed (HTTP ' + res.status + ')', 'error'); return; }
            S.sel = Object.assign({}, S.sel, { currentModel: modelId });
            showToast(S.sel.name + ' synchronized to ' + modelId);
            fetchProviders();
          }

          root.addEventListener('click', function (ev) {
            var t = ev.target.closest('[data-provider],[data-variant],[data-model],[data-bind]');
            if (!t) return;
            if (t.dataset.bind) { bindModel(t.dataset.bind); return; }
            if (t.dataset.provider) { selectProvider(t.dataset.provider); return; }
            // Inspection deliberately survives a filter change: the inspect row reads S.inspect back out
            // of the FILTERED set, so a model the filter hides falls back to the hint on its own and one
            // that survives stays selected. Clearing it here would lose the selection either way.
            if (t.dataset.variant) {
              S.variant = S.variant === t.dataset.variant ? null : t.dataset.variant;
              render(); return;
            }
            if (t.dataset.model) { S.inspect = t.dataset.model; render(); }
          });

          window.addEventListener('resize', function () {
            var m = window.innerWidth < 768;
            if (m !== S.mobile) { S.mobile = m; render(); }
          });

          render();
          fetchProviders();
        </script>
      </body>
      </html>
    `,
      { headers: { "Content-Type": "text/html" } },
    );
  } else if (req.method === "POST") {
    if (url.pathname === "/api/update") {
      if (!isAdmin(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const { provider, model } = await req.json();
      if (typeof provider !== "string" || !provider) return Response.json({ error: "provider required" }, { status: 400 });
      // model:null (or "") clears the override so the row falls back to its catalog default — there was
      // previously no way to UNBIND, only to bind something else, which is how a dead "inkling-small" override
      // outlived the catalog fix underneath it.
      if (model == null || model === "") {
        const d = await run(sql`DELETE FROM omni_router_config WHERE provider = ${provider}`);
        if (!d.ok) return Response.json({ error: d.error }, { status: 500 });
        return Response.json({ success: true, cleared: d.value.rowsAffected });
      }
      const r = await run(
        sql`INSERT INTO omni_router_config (provider, selected_model)
            VALUES (${provider}, ${model})
            ON CONFLICT(provider)
              DO UPDATE SET selected_model = excluded.selected_model`,
      );
      if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
      return Response.json({ success: true });
    }

    // Item 2: previously missing entirely — ui-settings.ts's "clear cooldowns" button has been calling
    // this exact path since it was written, silently swallowing the 404. Clears every open circuit
    // There are no cooldowns to clear any more: the circuit breaker, its persisted cross-isolate state
    // and the demotion table were deleted along with the 35-instance roster they existed to manage. The
    // route stays because the settings UI calls it, and it now does the only thing left that "reset"
    // can honestly mean — clear the durable counters behind the health table.
    if (url.pathname === "/api/reset") {
      if (!isAdmin(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
      await resetProviderStats();
      return Response.json({ success: true, cleared: "provider_stats", note: "router cooldowns no longer exist" });
    }

    // Item 4: clears the durable provider_stats counters (requests/ok/failed/last_error) — distinct from
    // /api/reset above, which clears the live routing decision, not the historical numbers. Separated so
    // clearing a stuck cooldown doesn't also erase diagnostic history, and vice versa.
    if (url.pathname === "/api/reset-stats") {
      if (!isAdmin(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
      await resetProviderStats();
      return Response.json({ success: true });
    }

    if (!OPENAI_PATHS.has(url.pathname)) return new Response("Not Found", { status: 404 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400, headers: CORS });
    }
    return await handleChatCompletions(body);
  }

  return new Response("Not Found", { status: 404 });
}