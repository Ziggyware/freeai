// Two exemplars per prompt, appended to every rendered prompt (Settings → "few-shot examples", default on).
// Few-shot anchoring is the strongest single lever on output quality for open-weight models: they imitate the
// register and density of what they are shown. Each pair is deliberately small — the standard is demonstrated,
// not the whole artifact — so the system prompt stays under free-tier input ceilings (groq ≈ 6.5k tokens).
import type { PromptKey } from "./prompts.ts";

const ex = (title: string, a: string, b: string) => `\nEXAMPLES — ${title}. Match this register, density and completeness exactly.\n<example>\n${a.trim()}\n</example>\n<example>\n${b.trim()}\n</example>`;

export const PROMPT_EXAMPLES: Record<PromptKey, string> = {
  system: ex("answers at the required standard",
`USER: why does my WebGL texture look washed out on Safari but not Chrome?
ASSISTANT: Safari applies the canvas's colorSpace conversion twice when the drawing buffer is premultiplied and the texture is uploaded with UNPACK_COLORSPACE_CONVERSION_WEBGL left at BROWSER_DEFAULT_WEBGL. Set it once before texImage2D:
\`\`\`js
gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
\`\`\`
and create the context with { premultipliedAlpha: false } if you composite yourself. Verify: a 50 % grey PNG must sample as 0.5 ± 0.004 in the shader on both browsers (read it back with gl.readPixels on a 1×1 quad). If it still differs, the PNG carries a gAMA chunk — strip it (pngcrush -rem gAMA) so both decoders agree.`,
`USER: build a metronome app
ASSISTANT: [create_artifact index.html, then one update_artifact per file — 8 calls, one file each, in dependency order: style.css, main.js, state.js, audio.js (AudioContext scheduler with 25 ms lookahead, 100 ms scheduleAhead, drift-free via ctx.currentTime), render.js (dpr-scaled canvas beat ring, rAF with delta, pauses on visibilitychange), input.js (pointer + keyboard: space start/stop, ↑↓ ±1 BPM, ⇧↑↓ ±10, T tap-tempo with 4-tap median), storage.js (schemaVersion 2 + migrate(), try/catch, memory fallback), README.md (12 features, shortcuts, run instructions)]
Metronome #41 is live in the workbench: 20–300 BPM, 1–12 beats with accent pattern editor, subdivisions (1/2/3/4), tap tempo, tempo ramp (start → end BPM over N bars), presets with undo, sample-accurate scheduling (jitter < 1 ms measured over 10 min), full keyboard control (? opens the shortcut sheet), dark/light via prefers-color-scheme. Does not do: MIDI clock out, polyrhythm across two meters.`),

  meta: ex("control block",
`<<<META {"confidence": 0.92, "stakes": "low", "abstain": false} META>>>`,
`<<<META {"confidence": 0.35, "stakes": "high", "abstain": true} META>>>`),

  firstExchange: ex("session titles",
`ask: "my shader flickers when I resize the window" → name_session("WebGL Resize Flicker")`,
`ask: "write me a pomodoro app with stats" → name_session("Pomodoro Stats App")`),

  plan: ex("plans",
`1. read_artifact #12 render.js and input.js only — the reported bug is a drag offset, so state.js is irrelevant.
2. Locate the pointer→world transform; the symptom (offset grows with zoom) means dpr or zoom is applied twice.
3. One update_artifact with the fix in render.js and a regression guard (assert in dev mode).
Stop when: the transform is applied exactly once and lint is clean.`,
`1. eval_js: compute the 12-TET frequency table for A4 = 432 and 440 (24 values) — never eyeball.
2. Answer with a table (note, 440 Hz, 432 Hz, Δ cents = 1200·log2(432/440) = −31.77 constant).
Stop when: table delivered with the constant-cents observation stated once.`),

  reconcile: ex("reconciled answers",
`Drafts disagree on Deno's default V8 heap limit. Draft A cites the flag (--v8-flags=--max-old-space-size) with a number; B and C give different numbers with no source. Keep A's mechanism, drop all three numbers, state the flag and how to read the actual limit at runtime (Deno.memoryUsage / --v8-flags=--help).`,
`All drafts agree the bug is an off-by-one in the ring buffer; A alone shows the failing index (write === read after wrap). Keep A's proof, keep B's shorter fix (mask with & (N-1) for power-of-two N), drop C's rewrite.`),

  critique: ex("verdicts",
`FLAW: The answer claims requestAnimationFrame runs at 60 Hz. It runs at the display's refresh rate (120/144 Hz on many devices), so the physics step derived as 1/60 s is wrong; the loop must use the timestamp delta. Consequential: motion speed doubles on 120 Hz screens.`,
`FLAW: none found. Checked: the regex escapes '.' correctly, the unit conversion (m/s² → g) divides by 9.80665, and the code block runs (eval_js returned the stated 42.0).`),

  revise: ex("revisions",
`(only the changed paragraph) The loop must read the timestamp rAF passes and integrate with dt = (t − last) / 1000, clamped to ≤ 0.05 s so a background tab does not explode the simulation; 1/60 is wrong on 120 Hz displays.`,
`(only the changed line) ⋯ divides by 9.80665 m/s² (standard gravity), not 9.8 — the 0.02 % error compounds over the integration.`),

  reground: ex("grounded answers",
`web_search("Deno 2.4 release notes") → snippet: "Deno 2.4 (July 2025) adds deno bundle …" (deno.com/blog, 2025-07-16). Answer: bundling returned in 2.4; the quoted note is the primary source. Not established: whether it supports code-splitting — the note does not say.`,
`web_search returned only forum posts with no dates for the claimed API change. Missing: a changelog or docs page. I cannot confirm the change; here is what would settle it: the package's CHANGELOG entry for the version you run.`),

  continue: ex("continuations",
`(previous output ended: "  for (const p of particles) {")
    p.vx += g.x * dt; p.vy += g.y * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
  }`,
`(previous output ended: "The second constraint is")
 that the buffer must be power-of-two sized, so the wrap is a mask instead of a modulo.`),

  summarize: ex("closing summaries",
`Built #57 "Spectrum Analyzer": 10 files, 1,180 lines. Mic or file input, 4096-point FFT (radix-2, Hann window), log-frequency canvas at device pixel ratio, peak hold, A-weighting toggle, keyboard (space pause, ↑↓ gain, W weighting), settings persisted (schema v1). Open it in the workbench to run. Does not do: MP3 decoding in Safari < 17 (decodeAudioData limitation).`,
`Found the cause: state.js:88 mutates the array it is iterating, so every other item is skipped on delete. Fixed with a filtered copy; added a regression check in dev mode. No other file touched.`),

  workbench: ex("focused edits",
`ask: "the canvas is blurry" (open file render.js) → read_artifact render.js → one update_artifact: edits = [{find: "canvas.width = w; canvas.height = h;", replace: "const dpr = Math.min(devicePixelRatio || 1, 3); canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);"}] → "Backing store now scales with devicePixelRatio (capped at 3); layout size unchanged."`,
`ask: "add undo" (open file state.js) → read_artifact state.js, input.js → one update_artifact: files = [{path: "history.js", content: <complete command stack: push/undo/redo, coalescing of drag steps, 200-entry cap>}], edits in state.js (dispatch records inverse), input.js (⌘Z/⇧⌘Z), index.html (script tag) → "Undo/redo with drag coalescing; 200 steps; shortcuts listed in the help panel."`),

  skill: ex("applying a skill",
`Skill "css-tokens" says every color must come from a custom property → the artifact's style.css defines :root tokens and no rule uses a literal hex; index.html sets data-theme from prefers-color-scheme.`,
`Skill "no-deps" says no external code → the chart is drawn with canvas 2D and a 60-line scale/axis module instead of a library.`),

  design: ex("a design document a builder can implement without guessing",
`ASK: a holographic interference simulator

# Interference Field
A single-page simulator showing the intensity pattern produced by two or more coherent point sources.

## Domain model
Each source i has position p_i (metres), amplitude A_i, wavelength lambda_i, phase phi_i.
Complex field at point r: U(r) = sum_i A_i / |r - p_i| * exp(j * (k_i * |r - p_i| + phi_i)), k_i = 2*pi/lambda_i.
Displayed intensity I(r) = |U(r)|^2, normalised to the 99th percentile of the frame so a bright
singularity near a source cannot flatten the rest of the field. Screen plane is z = z0; all lengths in
metres, angles in radians.

## Modules
### field.js
exports: computeField(sources, grid, z0) -> Float32Array of I, normalise(buf) -> Float32Array
imports: nothing. Pure; no DOM, no canvas.

## Acceptance criteria
1. Two sources of equal wavelength produce visible fringes whose spacing widens as the sources move closer.
2. Setting one amplitude to 0 removes all fringes and leaves a smooth radial falloff.`,
`ASK: a keyboard-driven task tracker

# Tracklist
A keyboard-first task list that persists locally and never needs a mouse.

## Purpose and scope
Capture, reorder, complete and filter tasks. NOT: due dates, projects, sharing, sync, notifications.

## State
tasks: Array<{id: string, text: string, done: boolean, order: number}> - created by add(), mutated by
toggle()/reorder()/remove(), read by render(). filter: "all" | "open" | "done", default "all".
selected: string | null - the id under the caret, null when the list is empty.

## Modules
### store.js
exports: load(), save(state), add(text), toggle(id), remove(id), reorder(id, delta), setFilter(f), getState()
imports: nothing. Owns all mutation; every write goes through save().
### keys.js
exports: bindKeys(store, render)
imports: store.js. j/k move, Enter toggles, d removes, J/K reorder, 1/2/3 set filter, / focuses input.

## Acceptance criteria
1. Adding a task then reloading the page shows the same task in the same position.
2. Pressing d removes the selected task and moves the caret to the next one, or the previous one at the end.
3. Every action in keys.js is reachable without touching the mouse.`),

  architect: ex("manifests",
`{"title": "Pomodoro Stats", "summary": "Focus timer with session history and analytics.",
 "features": ["25/5/15 cycles with editable durations", "start/pause/skip with space and S", "long break every 4th", "session log with tags", "daily/weekly bar chart", "streaks", "notification + sound at end (feature-detected)", "keyboard shortcut sheet (?)", "export/import JSON", "undo delete of a session", "dark/light tokens", "persisted settings + history schema v1 with migrate()"],
 "visual": "--bg #0f1115 --surface #171a21 --text #e6e8ef --accent #ff6b4a --danger #ff4d6d; Inter/system type 13/15/20/28; 4 px spacing unit; radius 10; 160 ms ease-out",
 "shared": "store.js: createStore(reducer, init) → {get, dispatch, subscribe}; actions {type:'TICK', now} {type:'START'} {type:'PAUSE'} {type:'COMPLETE', session:{id, start, end, kind, tag}}; state {phase:'focus'|'short'|'long', running, remainingMs, sessions[], settings}; ids = crypto.randomUUID() with Date.now()-based fallback; DOM ids #timer #ring #log #chart #help; CSS classes .btn .btn-primary .card",
 "files": [{"path": "index.html", "purpose": "markup + boot; loads siblings in order", "exports": [], "imports": ["style.css", "main.js"], "notes": ""}, {"path": "store.js", "purpose": "typed reducer store + undo stack", "exports": ["createStore(reducer, init)", "undoable(reducer)"], "imports": [], "notes": "pure"}, {"path": "timer.js", "purpose": "drift-free ticking from performance.now(), pauses on visibilitychange", "exports": ["startTicker(store)"], "imports": ["./store.js"], "notes": ""}, {"path": "render.js", "purpose": "ring on dpr-scaled canvas, log list, chart", "exports": ["mount(store)"], "imports": ["./store.js", "./chart.js"], "notes": "ResizeObserver"}, {"path": "chart.js", "purpose": "bar chart, canvas 2D, axis/scale helpers", "exports": ["drawBars(ctx, data, opts)"], "imports": [], "notes": ""}, {"path": "input.js", "purpose": "pointer + keyboard map", "exports": ["bindInput(store)"], "imports": ["./store.js"], "notes": ""}, {"path": "storage.js", "purpose": "versioned persistence, migrate(), memory fallback", "exports": ["load()", "save(state)", "SCHEMA_VERSION"], "imports": [], "notes": "try/catch"}, {"path": "notify.js", "purpose": "Notification + WebAudio beep, both feature-detected", "exports": ["notifyEnd(kind)"], "imports": [], "notes": ""}, {"path": "style.css", "purpose": "tokens, layout, states, motion", "exports": [], "imports": [], "notes": "prefers-color-scheme"}, {"path": "README.md", "purpose": "features, shortcuts, run, file map", "exports": [], "imports": [], "notes": ""}],
 "acceptance": ["space toggles", "ring is crisp at dpr 2", "reload keeps history", "chart updates after COMPLETE", "? opens help", "delete then ⌘Z restores", "tab hidden 5 min → remaining time still correct", "opens from disk (file://)"]}`,
`{"title": "Tile Editor", "summary": "2D tilemap editor with layers and export.",
 "features": ["tileset upload (PNG as data URL file)", "grid with zoom/pan (wheel, space-drag)", "paint/erase/fill/rect tools (B/E/G/R)", "3 layers with visibility/lock", "undo/redo 200 steps", "minimap", "export JSON + PNG", "import JSON", "autosave schema v2", "keyboard shortcut sheet", "touch painting", "dark tokens"],
 "visual": "--bg #101214 --panel #191c20 --grid #2a2f36 --accent #7cf0c8; mono UI 12/14; 8 px unit; radius 6; 120 ms",
 "shared": "state {map:{w,h,layers:[{name, tiles:Uint16Array, visible, locked}]}, tool, sel:{x,y}, view:{x,y,zoom}}; actions PAINT{layer,x,y,id} FILL RECT SET_TOOL SET_VIEW UNDO REDO; render.js draws on dpr canvas; input.js converts client→cell via view; ids: #stage #tools #layers #minimap",
 "files": [… 11 files as above, each ≤ 250 lines …],
 "acceptance": ["fill respects bounds", "zoom keeps cursor cell fixed", "undo across tools", "PNG export pixel-exact", "runs from disk"]}`),

  builder: ex("files at the standard",
`\`\`\`js
// render.js — dpr-scaled canvas, ResizeObserver, rAF with delta, pauses when hidden
import { subscribe, get } from './store.js';
const canvas = document.getElementById('ring'); const ctx = canvas.getContext('2d');
let w = 0, h = 0, dpr = 1, raf = 0, last = 0, hidden = document.hidden;
const ro = new ResizeObserver(([e]) => { const r = e.contentRect; w = r.width; h = r.height; dpr = Math.min(devicePixelRatio || 1, 3); canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(0); });
ro.observe(canvas.parentElement);
document.addEventListener('visibilitychange', () => { hidden = document.hidden; if (!hidden) { last = performance.now(); loop(last); } });
function draw(dt) {
  const s = get(); ctx.clearRect(0, 0, w, h);
  const r = Math.min(w, h) * 0.42, cx = w / 2, cy = h / 2, frac = 1 - s.remainingMs / s.totalMs;
  ctx.lineWidth = 10; ctx.lineCap = 'round';
  ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--grid'); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--accent'); ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text'); ctx.font = \`600 \${Math.round(r * 0.5)}px system-ui\`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(fmt(s.remainingMs), cx, cy);
}
function loop(t) { if (hidden) return; const dt = Math.min(0.05, (t - last) / 1000); last = t; draw(dt); raf = requestAnimationFrame(loop); }
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return \`\${String(Math.floor(s / 60)).padStart(2, '0')}:\${String(s % 60).padStart(2, '0')}\`; };
export function mount() { subscribe(() => draw(0)); last = performance.now(); raf = requestAnimationFrame(loop); return () => { cancelAnimationFrame(raf); ro.disconnect(); }; }
\`\`\``,
`\`\`\`js
// storage.js — versioned persistence with migration, try/catch, in-memory fallback (file:// and private mode safe)
export const SCHEMA_VERSION = 2;
const KEY = 'pomodoro.v'; let mem = null;
const migrations = { 1: (s) => ({ ...s, sessions: (s.sessions || []).map((x) => ({ ...x, tag: x.tag ?? '' })) }) };
export function migrate(doc) { let v = doc.version || 1, data = doc.data; while (v < SCHEMA_VERSION) { data = migrations[v] ? migrations[v](data) : data; v++; } return data; }
export function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return migrate(JSON.parse(raw)); } catch (e) { /* quota, disabled, or corrupt: fall through */ }
  return mem;
}
export function save(state) {
  const doc = JSON.stringify({ version: SCHEMA_VERSION, data: state, savedAt: Date.now() });
  try { localStorage.setItem(KEY, doc); return 'local'; } catch (e) { mem = state; return 'memory'; }
}
\`\`\``),

  // Two cases with OPPOSITE verdicts, because a judge that only ever sees failures learns to find them.
  conform: ex("conformance verdicts",
`REQUEST: "build me a holographic interference app"
BUILT: "Signal Dashboard" — index.html, tokens.css, style.css, chart.js, data.js, README.md
{"matches": false, "built": "a generic time-series dashboard with three line charts and a CSV loader", "mismatches": ["the request asks for a HOLOGRAPHIC INTERFERENCE app — two coherent sources, path-length difference, a fringe pattern — and none of that exists; there is no wave, no phase, no interference term anywhere", "nothing renders a field or a fringe pattern; the only visual output is line charts of loaded data"], "extra": ["a CSV import path nobody asked for"]}`,
`REQUEST: "a keyboard-driven task tracker that works offline"
BUILT: "Tasks" — index.html, tokens.css, style.css, store.js, keys.js, render.js, persist.js, README.md
{"matches": true, "built": "a task tracker with a keyboard shortcut map and IndexedDB persistence that runs from disk", "mismatches": [], "extra": []}`),

  repair: ex("root-cause repairs", 
`GOAL: Uncaught TypeError: THREE.WebGLRenderer is not a constructor (render.js:27)
FILE render.js:27 — \`const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });\` — but three.module.js is a hand-written shim whose default export is a namespace object, so \`new THREE.WebGLRenderer\` constructs nothing.
{"rootCause": "three.module.js exports the WebGL renderer as a named export (\`export function WebGLRenderer\`) and has no default export; the file imports a default/shim instead, so THREE.WebGLRenderer is undefined and \`new\` throws. The import must bind the named export.", "edits": [{"find": "import * as THREE from \'./three.module.js\';", "replace": "import { WebGLRenderer, Scene, PerspectiveCamera } from \'./three.module.js\';"}, {"find": "const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });", "replace": "const renderer = new WebGLRenderer({ canvas, antialias: true });"}], "note": "bind the named export; no other line touched"}`,
`GOAL: Cannot read properties of null (reading \'addEventListener\') at bindUI (ui.js:6)
FILE ui.js:6 — \`document.getElementById(\'toolbar\').addEventListener(...)\`, and index.html loads ui.js in <head>, so #toolbar does not exist yet.
{"rootCause": "ui.js executes in <head> and binds #toolbar immediately, but the element is created later in the body; getElementById returns null and the property access throws.", "edits": [{"find": "bindUI();", "replace": "if (document.readyState === \'loading\') document.addEventListener(\'DOMContentLoaded\', bindUI, { once: true }); else bindUI();"}], "note": "bind after DOM is parsed; no markup or other script touched"}`),

  integrate: ex("integration passes",
`read_artifact #41 all:true → findings: input.js imports { startTicker } from './timer.js' but timer.js exports start(); render.js draws before store exists (load order); README lists 12 features, "tempo ramp" not implemented anywhere → one update_artifact: edits (timer.js export rename, index.html script order), files: [ramp.js — full implementation of the ramp: linear BPM interpolation per bar, UI in index.html, actions in store.js]. Then lint is clean; acceptance checks walked one by one in the reply.`,
`Lint: "state.js:120 empty function body — function exportJson() {}" → not deleted, implemented: serialize state (schema version + data), Blob download with a11y-labelled anchor, toast on success; and the matching importJson with validation errors surfaced in the UI.`),

  digest: ex("digests",
`Part 1/3 of error.log: 14 distinct errors. Load-bearing: ui.js:6:11 TypeError "Cannot read properties of null (reading 'addEventListener')" — bindUI() runs before #toolbar exists (script in <head>, no defer). storage.js:1 SyntaxError: constants.js has no export named DEFAULT_BOT (it exports DEFAULT_BOT_ID). Repeats: 11× the same TypeError. Numbers: first error at t=0.312 s after load.`,
`Part 2/2 of api.md: endpoints POST /v1/jobs {name, cron} → 201 {id}; GET /v1/jobs/{id} → {status: 'queued'|'running'|'done'|'failed', attempts ≤ 3}; rate limit 60/min per key (header x-rate-remaining); errors as {error:{code,message}}; timestamps RFC 3339 UTC.`),

  completion: ex("audits",
`{"done": false, "quality": 2, "remaining": ["Implement the tempo ramp feature named in README (ramp.js: start→end BPM over N bars, UI controls, store actions)", "Scale the canvas by devicePixelRatio in render.js", "Add keyboard control for every toolbar action and the ? shortcut sheet", "Persist settings with SCHEMA_VERSION + migrate() in storage.js", "Add empty state for the session log", "Replace alert() in input.js with the in-app toast"]}`,
`{"done": true, "quality": 5, "remaining": []}`),

  brief: ex("design briefs",
`PRODUCT — A drift-free practice metronome musicians keep open for an hour: sample-accurate, fully keyboard-driven, remembers every preset.
FEATURES — 1. BPM 20–300 via drag ring, ±1/±10 keys, typed entry. 2. Tap tempo (T), 4-tap median, outlier rejection. 3. Beats/bar 1–12 with per-beat accent editor (click/tap cycles off·low·high). 4. Subdivisions 1/2/3/4 with distinct timbre. 5. Tempo ramp start→end over N bars with live readout. 6. Presets: save/rename/delete/reorder, undo delete. 7. Practice log: minutes per day, sparkline. 8. Visual beat ring + flash, dpr-crisp, pauses when hidden without losing the beat grid. 9. Shortcut sheet (?), all actions reachable by keyboard. 10. Sound sets (click/wood/beep) via WebAudio synthesis, no files. 11. Settings + presets persisted, schema v1 + migrate(). 12. Dark/light tokens, reduced-motion respected.
VISUAL SYSTEM — --bg #0e0f12 --surface #16181d --text #e8e9ee --dim #8b90a0 --accent #ffb454 --danger #ff5c5c; type 12/14/18/40 (BPM), tabular numerals; 4 px unit; radius 12; 140 ms ease-out. Identity: the beat ring's accent flash is the only saturated element.
ARCHITECTURE — index.html, style.css, main.js (boot), store.js (reducer + undo), audio.js (lookahead scheduler 25/100 ms, ctx.currentTime clock), timer.js (bar/beat counting from audio clock), render.js (ring, log, sparkline), input.js (pointer/keyboard/touch), presets.js, storage.js (v1), README.md. State {bpm, beats, accents[], subdiv, ramp{on,from,to,bars}, running, presets[], log[], settings}.
EDGE CASES — resize during ramp; 0 presets; 500 log days; BPM typed as "abc"; storage disabled; audio context suspended until first gesture (show a "tap to enable sound" state); keyboard-only from cold load; two-finger touch on the ring.
ACCEPTANCE — jitter < 1 ms over 10 min (measured against ctx.currentTime); ring crisp at dpr 2; reload restores presets; ? opens sheet; T×4 sets tempo; hidden 10 min → still on beat; runs from file://; reduced-motion disables flash.`,
`PRODUCT — A tilemap editor a game jammer finishes a level in: tileset in, layers, tools, undo, JSON/PNG out, nothing to install.
FEATURES — 1. Tileset PNG upload → tile size auto-detect + override. 2. Zoom/pan (wheel, space-drag, pinch) keeping the cursor cell fixed. 3. Paint/erase/fill/rect/pick tools with keys B E G R I. 4. 3 layers: rename, visibility, lock, reorder. 5. Undo/redo 200 steps with stroke coalescing. 6. Minimap with viewport rectangle. 7. Export JSON (schema v2) and PNG (pixel-exact). 8. Import JSON with validation report. 9. Autosave every change, restore on load. 10. Shortcut sheet (?). 11. Touch painting with palm rejection (pointerType). 12. Dark tokens + reduced motion.
VISUAL SYSTEM — --bg #0f1113 --panel #181b1f --grid #262b31 --accent #6ee7b7 --danger #f87171; mono 12/13, UI 14; 8 px unit; radius 6; 100 ms.
ARCHITECTURE — index.html, style.css, main.js, store.js, history.js, tools.js, render.js, input.js, tileset.js, io.js (export/import), storage.js (v2), README.md. State {map{w,h,tileSize,layers[]}, tileset{img,cols,rows}, tool, brush, view{x,y,zoom}, sel}.
EDGE CASES — tileset larger than 4096 px; map resize with content; fill on a locked layer; undo past import; storage full; import with wrong schema; keyboard-only; 2-finger pan while painting.
ACCEPTANCE — fill bounded; zoom pivot exact; undo across tools; PNG export matches canvas; reload restores; runs from file://; ? sheet complete; touch paint on iPad.`),

  compact: ex("running summaries",
`GOAL — Browser metronome app (#41 "Metronome", 9 files) the user practises with daily; now adding a practice log.
STANDING INSTRUCTIONS — no placeholders ever; ≤ 250 lines per file; dark theme default; keyboard for every action.
STATE — #41 files: index.html, style.css, main.js, store.js, audio.js (lookahead 25/100 ms), timer.js, render.js, input.js, storage.js (SCHEMA_VERSION 2), README.md.
DONE — tap tempo (4-tap median); ramp feature (ramp.js added this session); storage migration v1→v2 (accents array).
OPEN — practice log: user wants minutes/day + sparkline (render.js), persisted (storage v3 with migrate). Undo for preset delete still missing.
FACTS — user measured jitter 0.6 ms over 10 min; Safari needs AudioContext resume on first pointerdown (fixed in main.js:12); user's display is 120 Hz (delta-time bug found earlier, fixed).`,
`GOAL — Debug and harden a WebGL2 hologram renderer the user pasted (single file, ~900 lines), then port it to ES modules.
STANDING INSTRUCTIONS — Fisher-dense replies, no restating; answers ≤ 5000 chars; artifacts must run from file://.
STATE — #58 "Hologram Renderer": index.html, gl.js, shaders.js (vert/frag as template strings), scene.js, input.js, README.md.
DONE — fixed premultiplied-alpha washout (UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE); moved shaders from fetch() to shaders.js for file:// portability; resize now uses ResizeObserver + dpr cap 2.
OPEN — user reports 45 fps on M1 at 4k: suspected per-frame uniform uploads in scene.js:140–170 (not yet profiled); wants a UBO.
FACTS — target GPU M1, Safari 17; user rejects any external library; precision: mediump breaks the interference pattern, must stay highp.`),
};
