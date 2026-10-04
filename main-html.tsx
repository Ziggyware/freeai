/** @jsxImportSource https://esm.sh/react@19.2.0 */
import { style } from "./main-style.ts";
import { script } from "./main-script.ts";
import { buildScript } from "./main-build-script.ts";
import { mdStyle } from "./ui-style-md.ts";
import { markdownScript } from "./ui-markdown.ts";
import { settingsHtml, settingsScript } from "./ui-settings.ts";
import { settingsStyle } from "./ui-style-settings.ts";
import { artifactHtml, artifactStyle } from "./ui-artifacts.ts";
import { artifactScript } from "./ui-artifacts-script.ts";
import { timelineScript, timelineStyle } from "./ui-timeline.ts";

const ICON = {
  menu: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4h12M2 8h12M2 12h12"/></svg>`,
  x: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>`,
  gear: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>`,
  send: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2L2 8l4 2 2 4 6-12z"/></svg>`,
  cmd: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="12" height="10"/><path d="M5 7l2 1.5L5 10M8.5 10h3"/></svg>`,
};

export const PAGE_HTML: string = `
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>ZIGGYWARE</title>
  <style>${style}${mdStyle}${settingsStyle}${timelineStyle}${artifactStyle}</style>
</head>
<body>
  <div id="sidebar" class="collapsed">
    <div id="sb-hdr"><span class="wordmark">Ziggyware</span><button class="ib" onclick="toggleSidebar()">${ICON.x}</button></div>
    <button id="new-btn" onclick="newChat()">${ICON.plus} New chat <kbd style="margin-left:auto;font-size:9px;color:var(--dim2)">⌘K</kbd></button>
    <div id="sessions"></div>
    <div id="sb-artifacts"></div>
  </div>

  <div id="main">
    <div id="top">
      <button class="ib" onclick="toggleSidebar()" title="sessions">${ICON.menu}</button>
      <span id="session-title" ondblclick="startRename()" title="double-click to rename">NEW CHAT</span>
      <input id="session-title-input" type="text" onblur="commitRename()" onkeydown="titleKey(event)" />
      <div class="modes" id="modes"><button data-view="chat" class="on" onclick="setView('chat')">chat</button><button data-view="build" onclick="setView('build')">build</button><button data-view="runs" onclick="setView('runs')">runs</button></div>
      <span class="pill opt" id="pill-model" onclick="SETTINGS.toggle(true)" title="routing · click for settings"><span class="dot"></span><span id="pill-model-t">best free</span></span>
      <button class="ib" onclick="PAL.open()" title="command palette (⌘K)">${ICON.cmd}</button>
      <button class="ib" onclick="SETTINGS.toggle()" title="settings (⌘,)">${ICON.gear}</button>
    </div>

    <div id="view-chat" class="view on">
      <div id="chat-wrap">
        <div id="chat">
          <div id="empty">
            <div class="empty-mark">// ziggyware free ai //</div>
            <h3>What are we building?</h3>
            <div class="hints"><span class="hint" onclick="prefill('/build ')">/build — plan + parallel builders + integrate</span><span class="hint" onclick="prefill('/plan ')">/plan — manifest only</span><span class="hint" onclick="prefill('/fix ')">/fix — repair the open artifact</span><span class="hint" onclick="PAL.open()">⌘K — everything else</span></div>
          </div>
          <div id="typing"><div class="typing-inner"><div class="typing-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><span id="typing-label">thinking</span><span id="progress"></span></div><div id="live-tl"></div><div id="live-think"></div><div id="live-draft" hidden><div class="ld-h">draft so far <span id="live-draft-n"></span></div><pre id="live-draft-t"></pre></div></div>
        </div>
        <div id="scroll-pill" onclick="scrollBottom()">↓ bottom</div>
      </div>
      <div id="bar">
        <div id="slash"></div>
        <div class="bar-inner" style="flex-direction:column;align-items:stretch;gap:4px">
          <div class="chips" id="chips"></div>
          <div style="display:flex;align-items:flex-end;gap:8px"><textarea id="inp" rows="1" placeholder="// message, or / for commands"></textarea><span id="char-count"></span><button id="send" onclick="sendMsg()" title="send (Enter)">${ICON.send}</button></div>
        </div>
        <div class="bar-meta"><span id="bar-status"></span><span class="sp"></span><span id="bar-tokens"></span><span class="bar-hints"><kbd>⏎</kbd> send <kbd>⇧⏎</kbd> newline <kbd>/</kbd> commands</span></div>
      </div>
    </div>

    <div id="view-runs" class="view"><div id="runs"><div id="runs-empty">no turns in this session yet</div></div></div>
  </div>

  <div id="pal" onclick="if(event.target===this)PAL.close()"><div id="pal-box"><input id="pal-in" placeholder="command, setting, artifact #, session…" autocomplete="off"><div id="pal-list"></div></div></div>
  ${settingsHtml}
  ${artifactHtml}
  <script>${markdownScript}</script>
  <script>${timelineScript}</script>
  <script>${settingsScript}</script>
  <script>${artifactScript}</script>
  <script>
    if (location.search.includes('debug')) { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/eruda'; s.onload = () => eruda.init(); document.head.appendChild(s); }
    ${script}
  </script>
  <!-- After main-script's tag on purpose: classic scripts share one global lexical scope, so this sees
       addMsg/fetchT/wait/currentSession, and sendWith's BUILD.drive() call resolves at turn time. -->
  <script>${buildScript}</script>
</body>
`;
