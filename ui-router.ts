// The router matrix UI, served by the MAIN APP at /router.
//
// It used to be a template literal inline in router.tsx, which was the reason router.tsx existed as
// a separate val at all: 340 lines of browser HTML and JS in a file whose job was HTTP routing. The
// router now lives inside the app (see router.ts), and app.tsx is close to Val Town's 80 kB per-file
// ceiling, so the markup lives here and is imported as a constant.
//
// Reads GET /api/providers and GET /api/models?provider=<id>, binds with POST /api/update. All three
// are served by the same app now, so every fetch below is a relative URL.
export const ROUTER_MATRIX_HTML =
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
`;
