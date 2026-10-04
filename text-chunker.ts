// ─────────────────────────────────────────────────────────────────────────────
// CHUNK ENGINE  ·  mobile-first  ·  Val Town Hono/Deno
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CHUNK = 10_000;
const MAX_BOUND = 1_000_000;

const CFG = Object.freeze({
  NORMALIZE: true,
  SAFE_SLICE: true,
  HTML_ESCAPE: true,
  JSON_ESCAPE: true,
});

const ESC: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

// ── Pure utilities ────────────────────────────────────────────────────────────

function escH(s: string): string {
  return CFG.HTML_ESCAPE ? s.replace(/[&<>"']/g, (c) => ESC[c]) : s;
}

function escJSON(v: unknown): string {
  return JSON.stringify(v)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/<!--/g, "<\\!--")
    .replace(/\u2028|\u2029/g, "");
}

function normalise(s: string): string {
  if (!CFG.NORMALIZE || !s) return s;
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function safeEnd(s: string, end: number): number {
  if (!CFG.SAFE_SLICE || end >= s.length) return end;
  const c = s.charCodeAt(end);
  return (c >= 0xDC00 && c <= 0xDFFF) ? end - 1 : end;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function parseInt10(v: unknown): number {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Domain types ──────────────────────────────────────────────────────────────

interface Chunk {
  readonly t: string;
  readonly i: number;
  readonly s: number;
  readonly e: number;
}

interface Meta {
  readonly count: number;
  readonly length: number;
  readonly size: number;
  readonly avg: number;
  readonly bytes: number;
}

interface Payload {
  readonly chunks: readonly Chunk[];
  readonly meta: Meta;
}

// ── Core logic ────────────────────────────────────────────────────────────────

function chunk(raw: string, size: number): readonly Chunk[] {
  if (!raw) return [];
  const text = normalise(raw);
  const out: Chunk[] = [];
  let i = 0;
  while (i < text.length) {
    const s = i;
    const e = safeEnd(text, Math.min(i + size, text.length));
    out.push({ t: text.slice(s, e), i: out.length, s, e });
    i = e;
  }
  return out;
}

function buildMeta(chunks: readonly Chunk[], len: number, size: number): Meta {
  const count = chunks.length;
  return {
    count,
    length: len,
    size,
    avg: count ? Math.round(len / count) : 0,
    bytes: len * 2,
  };
}

// ── Request parsing ───────────────────────────────────────────────────────────

async function parse(req: Request): Promise<{ text: string; size: number }> {
  const ct = req.headers.get("content-type") ?? "";
  let text = "";
  let size = 0;
  try {
    if (ct.includes("application/json")) {
      const j = await req.json();
      text = String(j?.text ?? "").trim();
      size = parseInt10(j?.chunkSize);
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const p = new URLSearchParams(await req.text());
      text = (p.get("text") ?? "").trim();
      size = parseInt10(p.get("chunkSize"));
    } else if (ct.includes("multipart/form-data")) {
      const f = await req.formData();
      text = String(f.get("text") ?? "").trim();
      size = parseInt10(f.get("chunkSize"));
    } else {
      text = (await req.text()).trim();
    }
  } catch (err) {
    console.warn("[chunk-engine] parse error:", err);
  }
  return { text, size };
}

// ── HTML template ─────────────────────────────────────────────────────────────

function html(text: string, payload: Payload): string {
  const safeText = escH(text);
  const safeJSON = escJSON(payload);
  const { meta } = payload;

  const metaLine = meta.count
    ? `${meta.count} chunks · ${meta.length} chars · ${meta.size} sz · ${meta.avg} avg`
    : "no chunks";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#030712">
<title>Chunk Engine</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #030712;
  --bg1:       #060e1f;
  --bg2:       #0c1629;
  --border:    #1a2744;
  --border2:   #243358;
  --text:      #c9d7f0;
  --muted:     #4e6a99;
  --dim:       #2a3f66;
  --accent:    #3b82f6;
  --accent2:   #60a5fa;
  --green:     #22c55e;
  --amber:     #f59e0b;
  --rose:      #f43f5e;
  --sel:       rgba(59,130,246,0.15);
  --sel-ring:  rgba(59,130,246,0.6);
  --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-ui:   "Berkeley Mono", "JetBrains Mono", ui-monospace, monospace;
  --r:         10px;
  --r-sm:      6px;
  --safe-b:    env(safe-area-inset-bottom, 0px);
}

html { height: 100%; background: var(--bg); }

body {
  min-height: 100%;
  padding: 16px 16px calc(16px + var(--safe-b));
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.logo {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--accent2);
}
#meta-bar {
  font-size: 11px;
  color: var(--muted);
  letter-spacing: .03em;
  flex: 1;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Section panels ── */
.section {
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  background: var(--bg2);
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  letter-spacing: .1em;
  color: var(--muted);
  text-transform: uppercase;
  border-bottom: 1px solid transparent;
  transition: border-color 100ms;
}
.section-head.open { border-bottom-color: var(--border); }
.section-head .chevron { transition: transform 150ms; font-size: 10px; }
.section-head.open .chevron { transform: rotate(180deg); }
.section-body { padding: 12px; display: none;}
.section-body.open { display: block; }

/* ── Grid layouts ── */
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }

/* ── Field ── */
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: .08em;
  text-transform: uppercase;
}
input[type="number"], input[type="text"] {
  width: 100%;
  padding: 7px 10px;
  background: var(--bg1);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
}
input[type="number"] { -moz-appearance: textfield; }
input[type="number"]::-webkit-inner-spin-button,
input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; }
input[type="number"]:focus,
input[type="text"]:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--sel-ring); }

textarea {
  width: 100%;
  min-height: 140px;
  max-height: 40px;
  background: var(--bg1);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  caret-color: var(--accent2);
}
textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--sel-ring); }

select {
  width: 100%;
  padding: 7px 10px;
  background: var(--bg1);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: var(--font-ui);
  font-size: 12px;
  outline: none;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234e6a99'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}
select:focus { border-color: var(--accent); }

/* ── Toggle row ── */
.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
.toggle-row label { font-size: 12px; color: var(--text); cursor: pointer; flex: 1; }
.toggle {
  position: relative; width: 32px; height: 18px; flex-shrink: 0;
}
.toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
.toggle-track {
  position: absolute; inset: 0;
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 9px;
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}
.toggle input:checked ~ .toggle-track { background: var(--accent); border-color: var(--accent); }
.toggle-thumb {
  position: absolute;
  top: 3px; left: 3px;
  width: 10px; height: 10px;
  background: #fff;
  border-radius: 50%;
  transition: transform 150ms;
  pointer-events: none;
}
.toggle input:checked ~ .toggle-track .toggle-thumb { transform: translateX(14px); }

/* ── Buttons ── */
.btn-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
button {
  padding: 8px 16px;
  background: var(--bg2);
  color: var(--text);
  border: 1px solid var(--border2);
  border-radius: 999px;
  font-family: var(--font-ui);
  font-size: 12px;
  letter-spacing: .04em;
  cursor: pointer;
  outline: none;
  transition: background 90ms, border-color 90ms, transform 60ms;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  min-height: 36px;
}
button:hover  { background: #0f1e3a; border-color: var(--accent); }
button:active { transform: translateY(1px); }
button:focus-visible { box-shadow: 0 0 0 2px var(--sel-ring); }
button:disabled { opacity: .35; cursor: default; }
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
button.primary:hover { background: var(--accent2); border-color: var(--accent2); }
button.danger { border-color: var(--rose); color: var(--rose); }
button.danger:hover { background: rgba(244,63,94,0.1); }
button.success { border-color: var(--green); color: var(--green); }
button.success:hover { background: rgba(34,197,94,0.1); }

/* ── Chain mode indicator ── */
#chainIndicator {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(34,197,94,0.08);
  border: 1px solid rgba(34,197,94,0.3);
  border-radius: var(--r-sm);
  margin-top: 10px;
  font-size: 11px;
  color: var(--green);
  letter-spacing: .04em;
}
#chainIndicator.active { display: flex; }
#chainCountdown {
  margin-left: auto;
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

/* ── Search bar ── */
#searchBar {
  display: none;
  gap: 8px;
  align-items: center;
  margin: 8px 0 4px;
}
#searchBar.visible { display: flex; }
#searchInput {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg1);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
}
#searchInput:focus { border-color: var(--accent); }
#searchStats { font-size: 11px; color: var(--muted); white-space: nowrap; }

/* ── Chunk cards ── */
#chunkPanel { margin-top: 6px; }
.panel-scroll { height: 460px; overflow-y: auto; padding-right: 2px; }

.chunk-card {
  margin-top: 8px;
  background: var(--bg1);
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: scroll;
  cursor: pointer;
  transition: border-color 100ms, box-shadow 100ms;
  -webkit-tap-highlight-color: transparent;
  max-height:120px;
}
.chunk-card:hover { border-color: var(--border2); }
.chunk-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--sel-ring), inset 0 0 0 9999px var(--sel);
}
.chunk-card.multi-sel {
  border-color: var(--amber);
  box-shadow: inset 0 0 0 9999px rgba(245,158,11,0.08);
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: .04em;
  background: var(--bg2);
  gap: 8px;
  flex-wrap: wrap;
}
.card-head .idx { color: var(--accent2); font-weight: 700; flex-shrink: 0; }
.card-badges { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }
.badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.badge-blue  { color: var(--accent2); border-color: rgba(96,165,250,0.3); }
.badge-green { color: var(--green);   border-color: rgba(34,197,94,0.3); }
.badge-amber { color: var(--amber);   border-color: rgba(245,158,11,0.3); }
.badge-muted { color: var(--muted);   border-color: var(--dim); }
.entropy-bar {
  height: 3px;
  background: var(--dim);
  border-radius: 2px;
  overflow: hidden;
}
.entropy-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 200ms;
}
.card-body {
  padding: 10px 12px;
}
.card-desc {
  font-size: 10px;
  color: var(--muted);
  font-style: italic;
  margin-bottom: 6px;
  letter-spacing: .02em;
}
.card-affix {
  font-size: 10px;
  color: var(--dim);
  font-family: var(--font-mono);
  padding: 3px 8px;
  background: rgba(59,130,246,0.06);
  border-left: 2px solid var(--dim);
  margin-bottom: 4px;
  word-break: break-all;
}
.card-affix.post { border-left-color: rgba(96,165,250,0.4); margin-top: 4px; margin-bottom: 0; }
.card-body pre {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
}
.card-body pre mark {
  background: rgba(245,158,11,0.35);
  color: var(--amber);
  border-radius: 2px;
  padding: 0 1px;
}

/* ── Controls row ── */
.controls-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
  flex-wrap: wrap;
}
#nav-label {
  font-size: 11px;
  color: var(--muted);
  margin-left: auto;
  letter-spacing: .04em;
  font-variant-numeric: tabular-nums;
}

/* ── Toast ── */
#toast {
  position: fixed;
  bottom: calc(20px + var(--safe-b));
  left: 50%;
  transform: translateX(-50%) translateY(8px);
  padding: 8px 16px;
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 999px;
  font-size: 12px;
  color: var(--accent2);
  letter-spacing: .04em;
  opacity: 0;
  transition: opacity 150ms, transform 150ms;
  pointer-events: none;
  z-index: 999;
  white-space: nowrap;
}
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (min-width: 480px) {
  body { padding: 20px 20px calc(20px + var(--safe-b)); }
  textarea { min-height: 180px; }
  .card-body pre { font-size: 12px; }
}
@media (min-width: 768px) {
  body { max-width: 900px; margin: 0 auto; padding: 28px; }
  .grid3 { grid-template-columns: 1fr 1fr 1fr; }
}
</style>
</head>
<body>

<header>
  <span class="logo">Chunk Engine</span>
  <span id="meta-bar">${metaLine}</span>
</header>

<!-- ── Input ── -->
<div class="section" id="sec-input">
  <div class="section-head open" onclick="toggleSection('sec-input')">
    Input <span class="chevron open">▾</span>
  </div>
  <div class="section-body open">
    <textarea id="ta" aria-label="Input text" spellcheck="false">${safeText}</textarea>
    <div class="btn-row">
      <button type="button" id="pasteBtn">Paste</button>
      <button type="button" class="primary" id="processBtn">Process</button>
      <button type="button" id="clearBtn" class="danger">Clear</button>
    </div>
  </div>
</div>

<!-- ── Chunking config ── -->
<div class="section" id="sec-chunk">
  <div class="section-head open" onclick="toggleSection('sec-chunk')">
    Chunking <span class="chevron open">▾</span>
  </div>
</div>
<div class="section" id="sec-chunk-addl">
  <div class="section-body open">
    <div class="grid3" style="margin-bottom:10px">
      <div class="field">
        <span class="field-label">Size</span>
        <input type="number" id="sizeInput" value="${
    meta.size || DEFAULT_CHUNK
  }" min="1" max="${MAX_BOUND}" inputmode="numeric" aria-label="Chunk size">
      </div>
      <div class="field">
        <span class="field-label">Overlap</span>
        <input type="number" id="overlapInput" value="0" min="0" max="10000" inputmode="numeric" placeholder="chars" aria-label="Overlap chars">
      </div>
      <div class="field">
        <span class="field-label">Min Length</span>
        <input type="number" id="minLenInput" value="0" min="0" inputmode="numeric" placeholder="drop below" aria-label="Min chunk length">
      </div>
    </div>
    <div class="grid2" style="margin-bottom:10px">
      <div class="field">
        <span class="field-label">Boundary Snap</span>
        <select id="boundaryMode">
          <option value="char">Character</option>
          <option value="word">Word</option>
          <option value="sentence">Sentence</option>
          <option value="paragraph">Paragraph</option>
          <option value="regex">Regex Pattern</option>
        </select>
      </div>
      <div class="field">
        <span class="field-label">Token Model</span>
        <select id="tokenModel">
          <option value="cl100k">cl100k (GPT-4 / Claude)</option>
          <option value="o200k">o200k (GPT-4o)</option>
          <option value="llama">LLaMA/Mistral</option>
          <option value="none">Off</option>
        </select>
      </div>
    </div>
    <div class="field" id="regexField" style="display:none;margin-bottom:10px">
      <span class="field-label">Split Regex</span>
      <input type="text" id="regexInput" placeholder="e.g. \\n\\n+" value="\\n\\n+">
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <label class="toggle-row">
        <span>Collapse whitespace</span>
        <span class="toggle">
          <input type="checkbox" id="collapseWS">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </span>
      </label>
      <label class="toggle-row">
        <span>Reverse order</span>
        <span class="toggle">
          <input type="checkbox" id="reverseOrder">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </span>
      </label>
      <label class="toggle-row">
        <span>NFKC normalize</span>
        <span class="toggle">
          <input type="checkbox" id="nfkcNorm">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </span>
      </label>
      <label class="toggle-row">
        <span>Strip BOM</span>
        <span class="toggle">
          <input type="checkbox" id="stripBOM" checked>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </span>
      </label>
    </div>
  </div>
</div>

<!-- ── Prefix / Postfix / Description ── -->
<div class="section" id="sec-affix">
  <div class="section-head" onclick="toggleSection('sec-affix')">
    Wrap &amp; Describe <span class="chevron">▾</span>
  </div>
  <div class="section-body">
    <div class="grid2" style="margin-bottom:10px">
      <div class="field">
        <span class="field-label">Global Prefix</span>
        <input type="text" id="globalPrefix" placeholder="e.g. &lt;chunk&gt;">
      </div>
      <div class="field">
        <span class="field-label">Global Postfix</span>
        <input type="text" id="globalPostfix" placeholder="e.g. &lt;/chunk&gt;">
      </div>
    </div>
    <div class="grid2" style="margin-bottom:10px">
      <div class="field">
        <span class="field-label">Per-chunk Prefix Template</span>
        <input type="text" id="perPrefix" placeholder="e.g. [CHUNK {i}/{n}]\n">
      </div>
      <div class="field">
        <span class="field-label">Per-chunk Postfix Template</span>
        <input type="text" id="perPostfix" placeholder="e.g. \n[END {i}]">
      </div>
    </div>
    <p style="font-size:10px;color:var(--muted);margin-bottom:10px">
      Templates: <code>{i}</code> = 1-based index · <code>{n}</code> = total · <code>{s}</code> = start offset · <code>{e}</code> = end offset · <code>{chars}</code> = length · <code>{tokens}</code> = est. tokens · <code>{hash}</code> = 8-char fingerprint
    </p>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <label class="toggle-row">
        <span>Show chunk descriptions</span>
        <span class="toggle">
          <input type="checkbox" id="showDesc" checked>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </span>
      </label>
      <label class="toggle-row">
        <span>Base64 output</span>
        <span class="toggle">
          <input type="checkbox" id="base64Mode">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </span>
      </label>
    </div>
    <div class="field" style="margin-top:10px">
      <span class="field-label">Description template</span>
      <input type="text" id="descTemplate" value="Chunk {i} of {n} · chars {s}–{e} · {tokens} tokens · hash {hash}">
    </div>
  </div>
</div>

<!-- ── Output Controls ── -->
<div id="outputSection" style="display:none">
  <!-- search -->
  <div id="searchBar">
    <input type="text" id="searchInput" placeholder="Regex search across chunks…" aria-label="Search chunks">
    <span id="searchStats"></span>
    <button type="button" id="searchClearBtn" style="padding:6px 10px;min-height:0">✕</button>
  </div>

  <!-- controls row -->
  <div class="controls-row">
    <button type="button" id="prevBtn">Prev</button>
    <button type="button" id="nextBtn">Next</button>
    <button type="button" id="copyBtn" class="success">Copy</button>
    <button type="button" id="jsonExportBtn">JSON</button>
    <button type="button" id="searchToggleBtn">Search</button>
    <button type="button" id="mergeBtn">Merge Sel.</button>
    <button type="button" id="chainBtn">Chain ▶</button>
    <span id="nav-label"></span>
  </div>

  <!-- chain indicator -->
  <div id="chainIndicator">
    <span>⏱ Chain copy active</span>
    <span id="chainCountdown">–</span>
    <button type="button" onclick="stopChain()" style="padding:4px 10px;min-height:0;font-size:11px;margin-left:4px">Stop</button>
  </div>

  <div class="panel-scroll" id="scrollWrap">
    <div id="chunkPanel" role="list"></div>
  </div>
</div>

<div id="toast"></div>

<script id="__d" type="application/json">${safeJSON}</script>
<script>
// ── Utils ────────────────────────────────────────────────────────────────────

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, function(c) {
    return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;';
  });
}

function normalizeText(s) {
  return s
    .replace(/\\r\\n/g, '\\n')
    .replace(/[\\u200B\\u200C\\u200D\\uFEFF]/g, '')
    .replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, '');
}

function safeSlice(str, start, end) {
  if (end < str.length) {
    var code = str.charCodeAt(end);
    if (code >= 0xDC00 && code <= 0xDFFF) end--;
  }
  return str.slice(start, end);
}

function showToast(msg, duration) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, duration || 1500);
}

function toggleSection(id) {
  var sec = document.getElementById(id);
  var head = sec.querySelector('.section-head');
  var body = sec.querySelector('.section-body');
  var chev = sec.querySelector('.chevron');
  head.classList.toggle('open');
  body.classList.toggle('open');
  chev.classList.toggle('open');
}

// ── Token estimation ─────────────────────────────────────────────────────────

var TOKEN_RATIOS = { cl100k: 3.7, o200k: 3.6, llama: 3.5, none: 0 };

function estimateTokens(text, model) {
  var r = TOKEN_RATIOS[model] || 3.7;
  return r > 0 ? Math.ceil(text.length / r) : null;
}

// ── Entropy ──────────────────────────────────────────────────────────────────

function shannonEntropy(text) {
  if (!text.length) return 0;
  var freq = {};
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    freq[c] = (freq[c] || 0) + 1;
  }
  var H = 0;
  var len = text.length;
  for (var ch in freq) {
    var p = freq[ch] / len;
    H -= p * Math.log2(p);
  }
  return H;
}

// ── Hash fingerprint (djb2 → 8 hex) ─────────────────────────────────────────

function fingerprint(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Template expansion ────────────────────────────────────────────────────────

function expandTemplate(tpl, vars) {
  return tpl
    .replace(/\\\\n/g, '\\n')
    .replace(/\\\\t/g, '\\t')
    .replace(/\\{i\\}/g, vars.i)
    .replace(/\\{n\\}/g, vars.n)
    .replace(/\\{s\\}/g, vars.s)
    .replace(/\\{e\\}/g, vars.e)
    .replace(/\\{chars\\}/g, vars.chars)
    .replace(/\\{tokens\\}/g, vars.tokens !== null ? vars.tokens : 'n/a')
    .replace(/\\{hash\\}/g, vars.hash);
}

// ── Boundary snapping ────────────────────────────────────────────────────────

function snapBoundary(text, end, mode) {
  if (mode === 'char' || end >= text.length) return end;
  var window = Math.min(200, end);
  var search = text.substring(end - window, end);
  var idx = -1;
  if (mode === 'paragraph') {
    idx = search.lastIndexOf('\\n\\n');
    if (idx !== -1) return end - window + idx + 2;
  }
  if (mode === 'sentence') {
    var m = search.match(/[.!?]\\s+[A-Z]/g);
    if (m) {
      var last = search.lastIndexOf(m[m.length - 1]);
      if (last !== -1) return end - window + last + 2;
    }
  }
  if (mode === 'word') {
    idx = search.lastIndexOf(' ');
    if (idx !== -1) return end - window + idx + 1;
  }
  return end;
}

// ── Core chunker ────────────────────────────────────────────────────────────

function makeChunks(rawText, cfg) {
  var text = rawText;

  if (cfg.stripBOM) text = text.replace(/^\\uFEFF/, '');
  if (cfg.nfkc) {
    try { text = text.normalize('NFKC'); } catch(e) {}
  }
  text = normalizeText(text);
  if (cfg.collapseWS) text = text.replace(/[ \\t]+/g, ' ');

  if (!text) return [];

  var chunks = [];

  if (cfg.boundaryMode === 'regex' && cfg.regexPattern) {
    try {
      var re = new RegExp(cfg.regexPattern, 'g');
      var parts = text.split(re).filter(function(p) { return p.length > 0; });
      var offset = 0;
      parts.forEach(function(part) {
        var s = text.indexOf(part, offset);
        var e = s + part.length;
        chunks.push({ text: part, index: chunks.length, start: s, end: e });
        offset = e;
      });
    } catch(e) {
      // fallback to char
    }
  }

  if (!chunks.length) {
    var size = cfg.size;
    var overlap = Math.max(0, Math.min(cfg.overlap, size - 1));
    var i = 0;
    while (i < text.length) {
      var s = i;
      var rawEnd = Math.min(i + size, text.length);
      var e = safeSlice(text, 0, 0).length >= 0
        ? (function() {
            var end = rawEnd;
            // surro guard
            if (end < text.length) {
              var code = text.charCodeAt(end);
              if (code >= 0xDC00 && code <= 0xDFFF) end--;
            }
            return end;
          })()
        : rawEnd;
      // boundary snap
      if (e < text.length) {
        e = snapBoundary(text, e, cfg.boundaryMode);
      }
      var slice = text.slice(s, e);
      chunks.push({ text: slice, index: chunks.length, start: s, end: e });
      i = e - overlap;
      if (i <= s) i = e; // prevent infinite loop on zero-advance
    }
  }

  // filter min length
  if (cfg.minLen > 0) {
    chunks = chunks.filter(function(c) { return c.text.length >= cfg.minLen; });
    // re-index
    chunks.forEach(function(c, i) { c.index = i; });
  }

  if (cfg.reverse) chunks.reverse();

  return chunks;
}

// ── State ────────────────────────────────────────────────────────────────────

var state = {
  chunks: [],
  current: 0,
  multiSel: [],
  chainTimer: null,
  chainInterval: 3000,
  searchRe: null
};

var LS_KEY = 'chunk-engine-v2';

function saveLS() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      text: document.getElementById('ta').value,
      size: document.getElementById('sizeInput').value,
      overlap: document.getElementById('overlapInput').value,
      boundary: document.getElementById('boundaryMode').value,
      tokenModel: document.getElementById('tokenModel').value,
      prefix: document.getElementById('globalPrefix').value,
      postfix: document.getElementById('globalPostfix').value,
      perPrefix: document.getElementById('perPrefix').value,
      perPostfix: document.getElementById('perPostfix').value,
      descTemplate: document.getElementById('descTemplate').value,
      showDesc: document.getElementById('showDesc').checked,
      collapseWS: document.getElementById('collapseWS').checked,
      reverseOrder: document.getElementById('reverseOrder').checked,
      nfkc: document.getElementById('nfkcNorm').checked,
      stripBOM: document.getElementById('stripBOM').checked,
      base64Mode: document.getElementById('base64Mode').checked,
      minLen: document.getElementById('minLenInput').value
    }));
  } catch(e) {}
}

function loadLS() {
  try {
    var d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!d) return;
    if (d.text) document.getElementById('ta').value = d.text;
    if (d.size) document.getElementById('sizeInput').value = d.size;
    if (d.overlap != null) document.getElementById('overlapInput').value = d.overlap;
    if (d.boundary) document.getElementById('boundaryMode').value = d.boundary;
    if (d.tokenModel) document.getElementById('tokenModel').value = d.tokenModel;
    if (d.prefix != null) document.getElementById('globalPrefix').value = d.prefix;
    if (d.postfix != null) document.getElementById('globalPostfix').value = d.postfix;
    if (d.perPrefix != null) document.getElementById('perPrefix').value = d.perPrefix;
    if (d.perPostfix != null) document.getElementById('perPostfix').value = d.perPostfix;
    if (d.descTemplate) document.getElementById('descTemplate').value = d.descTemplate;
    if (d.showDesc != null) document.getElementById('showDesc').checked = d.showDesc;
    if (d.collapseWS != null) document.getElementById('collapseWS').checked = d.collapseWS;
    if (d.reverseOrder != null) document.getElementById('reverseOrder').checked = d.reverseOrder;
    if (d.nfkc != null) document.getElementById('nfkcNorm').checked = d.nfkc;
    if (d.stripBOM != null) document.getElementById('stripBOM').checked = d.stripBOM;
    if (d.base64Mode != null) document.getElementById('base64Mode').checked = d.base64Mode;
    if (d.minLen != null) document.getElementById('minLenInput').value = d.minLen;
    if (d.boundary === 'regex') document.getElementById('regexField').style.display = '';
  } catch(e) {}
}

// ── Get config from DOM ──────────────────────────────────────────────────────

function getConfig() {
  return {
    size: Math.max(1, parseInt(document.getElementById('sizeInput').value, 10) || 10000),
    overlap: Math.max(0, parseInt(document.getElementById('overlapInput').value, 10) || 0),
    boundaryMode: document.getElementById('boundaryMode').value,
    regexPattern: document.getElementById('regexInput').value,
    tokenModel: document.getElementById('tokenModel').value,
    collapseWS: document.getElementById('collapseWS').checked,
    reverse: document.getElementById('reverseOrder').checked,
    nfkc: document.getElementById('nfkcNorm').checked,
    stripBOM: document.getElementById('stripBOM').checked,
    minLen: Math.max(0, parseInt(document.getElementById('minLenInput').value, 10) || 0),
    globalPrefix: document.getElementById('globalPrefix').value,
    globalPostfix: document.getElementById('globalPostfix').value,
    perPrefix: document.getElementById('perPrefix').value,
    perPostfix: document.getElementById('perPostfix').value,
    showDesc: document.getElementById('showDesc').checked,
    descTemplate: document.getElementById('descTemplate').value,
    base64Mode: document.getElementById('base64Mode').checked
  };
}

// ── Build full chunk output string ───────────────────────────────────────────

function buildChunkOutput(c, cfg, tokenModel) {
  var text = cfg.base64Mode ? btoa(unescape(encodeURIComponent(c.text))) : c.text;
  var tokens = estimateTokens(c.text, tokenModel);
  var hash = fingerprint(c.text);
  var vars = {
    i: c.index + 1,
    n: state.chunks.length,
    s: c.start,
    e: c.end,
    chars: c.text.length,
    tokens: tokens,
    hash: hash
  };
  var pre = expandTemplate(cfg.perPrefix, vars);
  var post = expandTemplate(cfg.perPostfix, vars);
  return cfg.globalPrefix + pre + text + post + cfg.globalPostfix;
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderChunks() {
  var panel = document.getElementById('chunkPanel');
  var outputSec = document.getElementById('outputSection');
  panel.innerHTML = '';

  if (!state.chunks.length) {
    outputSec.style.display = 'none';
    panel.innerHTML = '<p style="color:var(--muted);padding:8px 0;font-size:12px">No chunks — paste text and tap Process.</p>';
    outputSec.style.display = 'block';
    updateNavLabel();
    return;
  }

  outputSec.style.display = 'block';
  var cfg = getConfig();

  state.chunks.forEach(function(c, i) {
    var card = document.createElement('div');
    card.className = 'chunk-card';
    card.dataset.index = i;

    var tokens = estimateTokens(c.text, cfg.tokenModel);
    var hash = fingerprint(c.text);
    var entropy = shannonEntropy(c.text);
    var entropyMax = 8;
    var entropyPct = Math.round((entropy / entropyMax) * 100);
    var entropyColor = entropy < 3 ? 'var(--rose)' : entropy < 5 ? 'var(--amber)' : 'var(--green)';
    var lineCount = (c.text.match(/\\n/g) || []).length;

    var vars = {
      i: i + 1,
      n: state.chunks.length,
      s: c.start,
      e: c.end,
      chars: c.text.length,
      tokens: tokens,
      hash: hash
    };

    var tokenBadge = (cfg.tokenModel !== 'none' && tokens !== null)
      ? '<span class="badge badge-green">~' + tokens + ' tok</span>'
      : '';

    var headHTML =
      '<span class="idx">#' + (i + 1) + '</span>' +
      '<span class="badge badge-muted">' + c.text.length + ' ch</span>' +
      '<span class="badge badge-muted">' + lineCount + ' ln</span>' +
      tokenBadge +
      '<span class="badge badge-blue">' + hash + '</span>';

    var bodyHTML = '';

    if (cfg.showDesc) {
      var desc = expandTemplate(cfg.descTemplate, vars);
      bodyHTML += '<div class="card-desc">' + escapeHTML(desc) + '</div>';
    }

    if (cfg.perPrefix) {
      var pre = expandTemplate(cfg.perPrefix, vars);
      bodyHTML += '<div class="card-affix">PREFIX: ' + escapeHTML(pre) + '</div>';
    }

    var displayText = cfg.base64Mode ? btoa(unescape(encodeURIComponent(c.text))) : c.text;

    // Apply search highlight
    var renderedText = escapeHTML(displayText);
    if (state.searchRe) {
      try {
        renderedText = renderedText.replace(state.searchRe, function(m) {
          return '<mark>' + m + '</mark>';
        });
      } catch(e) {}
    }

    bodyHTML += '<pre>' + renderedText + '</pre>';

    if (cfg.perPostfix) {
      var post = expandTemplate(cfg.perPostfix, vars);
      bodyHTML += '<div class="card-affix post">POSTFIX: ' + escapeHTML(post) + '</div>';
    }

    // entropy bar
    var entropyBarHTML =
      '<div class="entropy-bar" style="margin-top:6px" title="Shannon entropy: ' + entropy.toFixed(2) + ' bits">' +
        '<div class="entropy-fill" style="width:' + entropyPct + '%;background:' + entropyColor + '"></div>' +
      '</div>';

    card.innerHTML =
      '<div class="card-head"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + headHTML + '</div></div>' +
      '<div class="card-body">' + bodyHTML + entropyBarHTML + '</div>';

    card.addEventListener('click', function(e) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        toggleMultiSel(parseInt(card.dataset.index, 10));
      } else {
        select(parseInt(card.dataset.index, 10));
      }
    });

    panel.appendChild(card);
  });

  select(Math.min(state.current, state.chunks.length - 1));
  updateSearchStats();
}

// ── Selection ────────────────────────────────────────────────────────────────

function select(idx) {
  var cards = document.querySelectorAll('.chunk-card');
  if (cards[state.current]) cards[state.current].classList.remove('selected');
  state.current = ((idx % state.chunks.length) + state.chunks.length) % state.chunks.length;
  if (cards[state.current]) {
    cards[state.current].classList.add('selected');
    cards[state.current].scrollIntoView({ block: 'nearest' });
  }
  updateNavLabel();
  autoCopyIfChain();
}

function toggleMultiSel(idx) {
  var pos = state.multiSel.indexOf(idx);
  var cards = document.querySelectorAll('.chunk-card');
  if (pos === -1) {
    state.multiSel.push(idx);
    if (cards[idx]) cards[idx].classList.add('multi-sel');
  } else {
    state.multiSel.splice(pos, 1);
    if (cards[idx]) cards[idx].classList.remove('multi-sel');
  }
  updateNavLabel();
}

function updateNavLabel() {
  var lbl = document.getElementById('nav-label');
  if (!state.chunks.length) { lbl.textContent = '0 chunks'; return; }
  var selStr = state.multiSel.length ? ' · ' + state.multiSel.length + ' marked' : '';
  lbl.textContent = (state.current + 1) + ' / ' + state.chunks.length + selStr;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

function copyCurrentChunk() {
  if (!state.chunks.length) return;
  var cfg = getConfig();
  var c = state.chunks[state.current];
  var out = buildChunkOutput(c, cfg, cfg.tokenModel);
  navigator.clipboard.writeText(out).then(function() {
    showToast('Copied chunk ' + (state.current + 1));
  }).catch(function() {});
}

function autoCopyIfChain() {
  if (state.chainTimer !== null) {
    copyCurrentChunk();
  }
}

// ── Merge selected ───────────────────────────────────────────────────────────

function mergeSelected() {
  if (state.multiSel.length < 2) { showToast('Select 2+ chunks (Ctrl/⌘+click)'); return; }
  var indices = state.multiSel.slice().sort(function(a, b) { return a - b; });
  var merged = indices.map(function(i) { return state.chunks[i].text; }).join('');
  var first = state.chunks[indices[0]];
  var last = state.chunks[indices[indices.length - 1]];
  var newChunk = { text: merged, index: 0, start: first.start, end: last.end };
  var remaining = state.chunks.filter(function(_, i) { return state.multiSel.indexOf(i) === -1; });
  remaining.splice(indices[0], 0, newChunk);
  remaining.forEach(function(c, i) { c.index = i; });
  state.chunks = remaining;
  state.multiSel = [];
  state.current = indices[0];
  renderChunks();
  showToast('Merged ' + indices.length + ' chunks');
}

// ── JSON export ──────────────────────────────────────────────────────────────

function exportJSON() {
  if (!state.chunks.length) return;
  var cfg = getConfig();
  var out = state.chunks.map(function(c) {
    var tokens = estimateTokens(c.text, cfg.tokenModel);
    var hash = fingerprint(c.text);
    var vars = { i: c.index + 1, n: state.chunks.length, s: c.start, e: c.end, chars: c.text.length, tokens: tokens, hash: hash };
    return {
      index: c.index + 1,
      start: c.start,
      end: c.end,
      chars: c.text.length,
      tokens: tokens,
      hash: hash,
      entropy: parseFloat(shannonEntropy(c.text).toFixed(4)),
      prefix: expandTemplate(cfg.perPrefix, vars),
      postfix: expandTemplate(cfg.perPostfix, vars),
      description: cfg.showDesc ? expandTemplate(cfg.descTemplate, vars) : undefined,
      text: c.text
    };
  });
  var json = JSON.stringify({ globalPrefix: cfg.globalPrefix, globalPostfix: cfg.globalPostfix, chunks: out }, null, 2);
  navigator.clipboard.writeText(json).then(function() {
    showToast('JSON copied (' + out.length + ' chunks)');
  }).catch(function() {});
}

// ── Chain mode ───────────────────────────────────────────────────────────────

function startChain() {
  if (state.chainTimer !== null) { stopChain(); return; }
  var interval = parseInt(prompt('Auto-advance interval (ms):', '3000'), 10);
  if (!interval || interval < 500) return;
  state.chainInterval = interval;
  copyCurrentChunk();
  state.chainTimer = setInterval(function() {
    if (state.current >= state.chunks.length - 1) {
      stopChain();
      showToast('Chain complete');
      return;
    }
    select(state.current + 1);
  }, state.chainInterval);
  document.getElementById('chainIndicator').classList.add('active');
  document.getElementById('chainBtn').textContent = 'Chain ■';
  updateChainCountdown();
}

function stopChain() {
  if (state.chainTimer !== null) {
    clearInterval(state.chainTimer);
    state.chainTimer = null;
  }
  document.getElementById('chainIndicator').classList.remove('active');
  document.getElementById('chainBtn').textContent = 'Chain ▶';
}

function updateChainCountdown() {
  if (state.chainTimer === null) return;
  var el = document.getElementById('chainCountdown');
  var remaining = state.chainInterval;
  var tick = setInterval(function() {
    remaining -= 100;
    el.textContent = (remaining / 1000).toFixed(1) + 's';
    if (remaining <= 0) { clearInterval(tick); if (state.chainTimer !== null) updateChainCountdown(); }
  }, 100);
}

// ── Search ───────────────────────────────────────────────────────────────────

function applySearch() {
  var q = document.getElementById('searchInput').value.trim();
  if (!q) { state.searchRe = null; }
  else {
    try { state.searchRe = new RegExp(q, 'gi'); } catch(e) { state.searchRe = null; }
  }
  renderChunks();
}

function updateSearchStats() {
  if (!state.searchRe || !state.chunks.length) {
    document.getElementById('searchStats').textContent = '';
    return;
  }
  var total = 0;
  var matchedChunks = 0;
  state.chunks.forEach(function(c) {
    var m = c.text.match(state.searchRe);
    if (m) { total += m.length; matchedChunks++; }
  });
  document.getElementById('searchStats').textContent = total + ' hits in ' + matchedChunks + ' chunks';
}

// ── Process ──────────────────────────────────────────────────────────────────

function processText() {
  var raw = document.getElementById('ta').value;
  var cfg = getConfig();
  state.chunks = makeChunks(raw, cfg);
  state.current = 0;
  state.multiSel = [];
  renderChunks();
  saveLS();

  // update meta bar
  var bar = document.getElementById('meta-bar');
  var total = state.chunks.reduce(function(a, c) { return a + c.text.length; }, 0);
  bar.textContent = state.chunks.length + ' chunks · ' + total + ' chars · ' + cfg.size + ' sz';
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadLS();

document.getElementById('processBtn').addEventListener('click', processText);

document.getElementById('pasteBtn').addEventListener('click', function() {
  navigator.clipboard.readText().then(function(t) {
    document.getElementById('ta').value = t;
  }).catch(function() {});
});

document.getElementById('clearBtn').addEventListener('click', function() {
  document.getElementById('ta').value = '';
  state.chunks = [];
  renderChunks();
  document.getElementById('meta-bar').textContent = 'no chunks';
  saveLS();
});

document.getElementById('prevBtn').addEventListener('click', function() { select(state.current - 1); });
document.getElementById('nextBtn').addEventListener('click', function() { select(state.current + 1); });
document.getElementById('copyBtn').addEventListener('click', copyCurrentChunk);
document.getElementById('jsonExportBtn').addEventListener('click', exportJSON);
document.getElementById('mergeBtn').addEventListener('click', mergeSelected);
document.getElementById('chainBtn').addEventListener('click', startChain);

document.getElementById('searchToggleBtn').addEventListener('click', function() {
  var bar = document.getElementById('searchBar');
  bar.classList.toggle('visible');
  if (bar.classList.contains('visible')) document.getElementById('searchInput').focus();
  else { state.searchRe = null; renderChunks(); }
});

document.getElementById('searchInput').addEventListener('input', applySearch);
document.getElementById('searchClearBtn').addEventListener('click', function() {
  document.getElementById('searchInput').value = '';
  state.searchRe = null;
  renderChunks();
  document.getElementById('searchBar').classList.remove('visible');
});

document.getElementById('boundaryMode').addEventListener('change', function() {
  document.getElementById('regexField').style.display =
    this.value === 'regex' ? '' : 'none';
});

// Keyboard nav
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select(state.current + 1); }
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); select(state.current - 1); }
  if (e.key === 'c' && !e.metaKey && !e.ctrlKey) copyCurrentChunk();
});

// Auto-process if server-rendered chunks exist
(function() {
  try {
    var d = JSON.parse(document.getElementById('__d').textContent);
    if (d && d.chunks && d.chunks.length) {
      state.chunks = d.chunks.map(function(c) {
        return { text: c.t, index: c.i, start: c.s, end: c.e };
      });
      renderChunks();
    }
  } catch(e) {}
})();
</script>

</body>
</html>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = async (req: Request): Promise<Response> => {
  let text = "";
  let reqSize = 0;

  if (req.method === "POST") {
    const parsed = await parse(req);
    text = parsed.text;
    reqSize = parsed.size;
  }

  const size = clamp(reqSize > 0 ? reqSize : DEFAULT_CHUNK, 1, MAX_BOUND);
  const chunks = chunk(text, size);
  const meta = buildMeta(chunks, text.length, size);
  const payload: Payload = Object.freeze({ chunks, meta });

  return new Response(html(text, payload), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

export default handler;