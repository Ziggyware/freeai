// Artifact workbench (markup + style). Full-screen by default: the chat hides while
// the workbench is open; the workbench carries its own composer so the model can be
// asked about the open artifact without leaving the editor. Preview sits to the RIGHT
// of the code (configurable: right | left | bottom). Script: ui-artifacts-script.ts.
export const artifactHtml: string = `
<div id="apanel" class="closed" aria-hidden="true">
  <div id="ap-resize" title="drag to resize"></div>
  <div id="ap-hdr">
    <button class="act-btn" onclick="ART.close()" title="back to chat (Esc)">← chat</button>
    <span id="ap-title">artifact</span>
    <div class="ap-tabs"><button class="ap-tab" data-view="code" onclick="ART.view('code')">code</button><button class="ap-tab" data-view="split" onclick="ART.view('split')">split</button><button class="ap-tab" data-view="preview" onclick="ART.view('preview')">preview</button></div>
    <div class="ap-acts">
      <label class="ap-live" title="re-render the preview as you type"><input type="checkbox" id="ap-livecb" checked> live</label>
      <button class="act-btn" onclick="ART.reload(true)" title="reload from server (⌘⏎)">run</button>
      <a class="act-btn" id="ap-open" href="#" target="_blank" rel="noopener">open ↗</a>
      <button class="act-btn" onclick="ART.zip()" title="download all files — runs from any static host or by opening index.html">zip</button>
      <button class="act-btn" onclick="ART.toggleSettings()" title="editor settings">⚙ editor</button>
    </div>
  </div>
  <div id="ap-jobs" hidden></div>
  <div id="ap-body">
    <div id="ap-code">
      <div id="ap-lint" hidden><div id="ap-lint-h"><span id="ap-lint-n"></span><button class="act-btn primary" onclick="ART.fixLint()">fix with ai</button><button class="act-btn" onclick="ART.copyLint()">copy</button></div><pre id="ap-lint-b"></pre></div>
      <div id="ap-find" hidden><input id="ap-find-in" placeholder="find (regex ok)"><input id="ap-find-rep" placeholder="replace"><button class="act-btn" onclick="ART.findNext(-1)">↑</button><button class="act-btn" onclick="ART.findNext(1)">↓</button><button class="act-btn" onclick="ART.replaceOne()">replace</button><button class="act-btn" onclick="ART.replaceAll()">all</button><label class="ap-live"><input type="checkbox" id="ap-find-all"> all files</label><span id="ap-find-n"></span><button class="ib" onclick="ART.findToggle(false)">×</button></div>
      <div id="ap-edrow">
        <div id="ap-tree"><div id="ap-tree-h"><span>files</span><button class="ib" onclick="ART.addFile()" title="new file (folders via a/b.js)">+</button><label class="ib" title="upload files or a .zip"><input type="file" multiple hidden onchange="ART.upload(this.files)">⇪</label></div><div id="ap-tree-b"></div><div id="ap-drop">drop files / zip here</div></div>
        <div id="ap-edwrap"><pre id="ap-gutter" aria-hidden="true"></pre><textarea id="ap-editor" spellcheck="false" wrap="off"></textarea><div id="ap-bin" hidden></div>
        </div>
      </div>
      <div id="ap-bar"><span id="ap-state"></span><span id="ap-pos"></span><button class="act-btn" onclick="ART.findToggle()" title="find / replace (⌘F)">find</button><button class="act-btn" onclick="ART.renameFile()">rename</button><button class="act-btn" onclick="ART.deleteFile()">delete</button><button class="act-btn" onclick="ART.revert()">revert</button><button class="act-btn" onclick="ART.copy()">copy</button><button class="act-btn" onclick="ART.askSelection()" title="ask the AI about the selected text">ask sel</button><button class="act-btn primary" onclick="ART.save()">save ⌘S</button></div>
    </div>
    <div id="ap-divider" title="drag"></div>
    <div id="ap-prev">
      <iframe id="ap-frame" sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups" loading="lazy"></iframe>
      <div id="ap-console" hidden><div id="ap-con-h"><span>console</span><button class="act-btn" onclick="ART.askFix()">ask ai to fix</button><button class="act-btn" onclick="ART.clearConsole()">clear</button><button class="act-btn" onclick="ART.hideConsole()">hide</button></div><div id="ap-con-body"></div></div>
    </div>
  </div>
  <div id="ap-ask">
    <div id="ap-reply" hidden><div id="ap-reply-h"><span id="ap-reply-t">reply</span><button class="act-btn" onclick="ART.close()">show in chat</button><button class="act-btn" onclick="ART.hideReply()">×</button></div><div id="ap-reply-b" class="md"></div></div>
    <div id="ap-ask-row"><textarea id="ap-ask-in" rows="1" placeholder="ask about this artifact… (⌘⏎ to send)"></textarea><span id="ap-ask-st"></span><button class="act-btn primary" id="ap-ask-go" onclick="ART.send()">ask</button></div>
  </div>
  <div id="ap-prompt" hidden><input id="ap-prompt-in" type="text"><button class="act-btn primary" id="ap-prompt-ok">ok</button><button class="act-btn" id="ap-prompt-no">cancel</button></div>
  <div id="ap-set" class="closed">
    <div id="ap-set-h"><span>editor settings</span><button class="ib" onclick="ART.toggleSettings(false)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
    <div id="ap-set-b">
      <section><h4>layout</h4>
        <label><input type="checkbox" data-e="hideChat"> hide chat while the workbench is open</label>
        <label>preview side <select data-e="side"><option value="right">right of code</option><option value="left">left of code</option><option value="bottom">below code</option></select></label>
        <label>default view <select data-e="defaultView"><option value="split">split</option><option value="code">code</option><option value="preview">preview</option></select></label>
        <label>preview share <input type="range" min="15" max="85" data-e="split"><output></output></label>
        <label>panel width (chat visible) <input type="range" min="30" max="100" data-e="width"><output></output></label>
      </section>
      <section><h4>preview</h4>
        <label><input type="checkbox" data-e="live"> live preview of unsaved edits</label>
        <label>live delay (ms) <input type="range" min="100" max="2000" step="100" data-e="liveDelay"><output></output></label>
        <label>console <select data-e="console"><option value="auto">open on output</option><option value="errors">open on errors only</option><option value="open">always open</option><option value="hidden">hidden</option></select></label>
        <label>console lines <input type="range" min="50" max="1000" step="50" data-e="consoleMax"><output></output></label>
        <label>frame background <select data-e="previewBg"><option value="#ffffff">white</option><option value="#000000">black</option><option value="#101418">dark</option><option value="transparent">transparent</option></select></label>
        <label><input type="checkbox" data-e="runOnOpen"> run from server on open</label>
      </section>
      <section><h4>editor</h4>
        <label>font size <input type="range" min="10" max="20" data-e="fontSize"><output></output></label>
        <label>tab size <select data-e="tabSize"><option value="2">2</option><option value="4">4</option><option value="8">8</option></select></label>
        <label><input type="checkbox" data-e="softTabs"> insert spaces for Tab</label>
        <label><input type="checkbox" data-e="lineNumbers"> line numbers</label>
        <label><input type="checkbox" data-e="wrap"> wrap long lines (hides line numbers)</label>
        <label><input type="checkbox" data-e="autoIndent"> auto-indent on Enter</label>
        <label><input type="checkbox" data-e="closeBrackets"> auto-close brackets and quotes</label>
        <label><input type="checkbox" data-e="lintOnType"> lint while typing</label>
        <label><input type="checkbox" data-e="codemirror"> syntax highlighting (CodeMirror, loaded from cdnjs)</label>
        <label><input type="checkbox" data-e="showTree"> file tree</label>
      </section>
      <section><h4>behavior</h4>
        <label><input type="checkbox" data-e="autoSave"> auto-save after edits</label>
        <label>auto-save delay (ms) <input type="range" min="500" max="5000" step="250" data-e="autoSaveDelay"><output></output></label>
        <label><input type="checkbox" data-e="saveBeforeAsk"> save unsaved edits before asking the AI</label>
        <label><input type="checkbox" data-e="autoOpen"> open the workbench when the AI creates an artifact</label>
        <label><input type="checkbox" data-e="reopen"> reopen the last artifact after a reload</label>
        <label><input type="checkbox" data-e="focusReply"> show the AI reply inside the workbench</label>
        <label><input type="checkbox" data-e="autoFixLint"> automatically ask the AI to fix lint issues (max 2 rounds per artifact)</label>
        <label><input type="checkbox" data-e="autoFixErrors"> automatically fix unhandled preview errors (script errors, rejections, missing files) <input type="number" min="1" max="10" data-e="autoFixRounds" style="width:3em"> rounds per artifact</label>
        <label>console lines sent to the AI <input type="range" min="0" max="12" data-e="errorsToAI"><output></output></label>
      </section>
      <section><h4>prompts</h4>
        <div class="pr-hint">Placeholders: {{id}} {{title}} {{file}} {{files}} {{selection}} {{errors}}</div>
        <label>ask (header button) <textarea data-e="pAsk" rows="2" spellcheck="false"></textarea></label>
        <label>fix from console <textarea data-e="pFix" rows="3" spellcheck="false"></textarea></label>
        <label>ask about selection <textarea data-e="pSel" rows="3" spellcheck="false"></textarea></label>
        <label>fix lint issues <textarea data-e="pLint" rows="3" spellcheck="false"></textarea></label>
        <label>prefix for every workbench message <textarea data-e="pPrefix" rows="2" spellcheck="false"></textarea></label>
        <label>integrate (after a swarm build) <textarea data-e="pIntegrate" rows="4" spellcheck="false"></textarea></label>
        <label>system focus block (server prompt "workbench") <textarea id="ap-p-workbench" rows="6" spellcheck="false"></textarea></label>
        <div class="st-row"><button class="st-btn" onclick="ART.resetPrompts()">reset prompts</button><button class="st-btn" onclick="ART.resetSettings()">reset all editor settings</button></div>
      </section>
    </div>
  </div>
</div>
`;

export const artifactStyle: string = `
#apanel{position:fixed;top:0;right:0;height:100dvh;width:var(--ap-w,52vw);max-width:100vw;background:var(--s0);border-left:1px solid var(--line);z-index:30;display:flex;flex-direction:column}
#apanel.closed{transform:translateX(100%)} body.ap-open:not(.ap-full) #main{margin-right:min(var(--ap-w,52vw),100vw)}
body.ap-full #apanel{width:100vw;border-left:0} body.ap-full #main{display:none} body.ap-full #ap-resize{display:none}
#ap-resize{position:absolute;left:-3px;top:0;width:6px;height:100%;cursor:col-resize;z-index:2}
#ap-hdr{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--acc);flex-wrap:wrap}
#ap-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-tabs{display:flex;gap:2px} .ap-tab{background:none;border:1px solid var(--line);color:var(--dim2);font:inherit;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;cursor:pointer} .ap-tab.on{border-color:var(--acc);color:var(--acc)}
.ap-acts{display:flex;gap:4px;align-items:center} .ap-acts .act-btn{text-decoration:none} .ap-live{font-size:9px;letter-spacing:.1em;color:var(--dim);display:flex;align-items:center;gap:3px} .ap-live input{accent-color:var(--acc);margin:0}
#ap-body{flex:1;display:flex;min-height:0;flex-direction:row;position:relative}
#apanel[data-view="preview"] #ap-code,#apanel[data-view="preview"] #ap-divider{display:none} #apanel[data-view="code"] #ap-prev,#apanel[data-view="code"] #ap-divider{display:none}
#ap-code{order:0} #ap-divider{order:1} #ap-prev{order:2}
#apanel[data-side="left"] #ap-code{order:2} #apanel[data-side="left"] #ap-prev{order:0}
#apanel[data-view="split"] #ap-prev{flex:0 0 var(--ap-split,50%)} #apanel[data-view="split"] #ap-divider{width:5px;cursor:col-resize;background:var(--line)}
#apanel[data-side="bottom"] #ap-body,#apanel.narrow #ap-body{flex-direction:column} #apanel[data-side="bottom"][data-view="split"] #ap-divider,#apanel.narrow[data-view="split"] #ap-divider{width:auto;height:5px;cursor:row-resize}
#ap-prev{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
#ap-frame{flex:1;width:100%;border:0;background:var(--ap-bg,#fff);min-height:0}
#ap-console{max-height:34%;display:flex;flex-direction:column;border-top:1px solid var(--line);background:var(--s0)} #ap-console[hidden]{display:none}
#ap-con-h{display:flex;gap:6px;align-items:center;padding:3px 8px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim2);border-bottom:1px solid var(--line)} #ap-con-h span{flex:1}
#ap-con-body{overflow:auto;font-size:11px;line-height:1.45;padding:4px 8px;font-family:var(--mono)} .con-line{white-space:pre-wrap;word-break:break-word;border-bottom:1px solid var(--line);padding:1px 0} .con-err{color:var(--err)} .con-warn{color:var(--warn)} .con-log{color:var(--dim)}
#ap-code{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
#ap-edrow{flex:1;display:flex;min-height:0}
#ap-tree{width:180px;flex-shrink:0;border-right:1px solid var(--line);display:flex;flex-direction:column;background:var(--s0);position:relative} #apanel.no-tree #ap-tree{display:none}
#ap-tree-h{display:flex;align-items:center;gap:2px;padding:3px 4px 3px 10px;border-bottom:1px solid var(--line);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2)} #ap-tree-h span{flex:1} #ap-tree-h .ib{width:22px;height:22px;font-size:13px}
#ap-tree-b{flex:1;overflow:auto;padding:4px 0;font-size:11px} .tr-d{color:var(--dim2);padding:2px 6px;cursor:pointer;white-space:nowrap;user-select:none} .tr-d::before{content:"▾ ";font-size:9px} .tr-d.closed::before{content:"▸ "} .tr-f{padding:2px 6px;cursor:pointer;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .tr-f:hover{color:var(--text);background:var(--s1)} .tr-f.on{color:var(--acc);background:var(--s1)} .tr-f.dirty::after{content:" •";color:var(--warn)} .tr-d.closed+.tr-kids{display:none}
#ap-drop{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(79,140,255,.12);border:1px dashed var(--acc);color:var(--acc);font-size:10px;letter-spacing:.1em;text-transform:uppercase;pointer-events:none} #ap-tree.drag #ap-drop{display:flex}
#ap-bin{flex:1;display:flex;align-items:center;justify-content:center;background:var(--bg);overflow:auto} #ap-bin[hidden]{display:none} #ap-bin img{max-width:100%;max-height:100%;image-rendering:auto} #ap-bin .bin-note{color:var(--dim2);font-size:11px}
#ap-find{display:flex;gap:4px;align-items:center;flex-wrap:wrap;background:var(--s1);border-bottom:1px solid var(--line);padding:4px 8px;flex-shrink:0} #ap-find[hidden]{display:none} #ap-find input{background:var(--bg);color:var(--text);border:1px solid var(--line2);font:inherit;font-size:11px;padding:3px 6px;width:150px} #ap-find-n{font-size:10px;color:var(--dim2);min-width:40px}
#ap-jobs{display:flex;gap:4px;flex-wrap:wrap;padding:4px 10px;border-bottom:1px solid var(--line);font-size:10px} #ap-jobs[hidden]{display:none} .job{border:1px solid var(--line2);padding:1px 6px;color:var(--dim2)} .job.building{border-color:var(--warn);color:var(--warn)} .job.ok{border-color:rgba(198,255,127,.4);color:var(--acc2)} .job.issues,.job.error{border-color:var(--err);color:var(--err)}
#ap-edwrap .CodeMirror.cm-s-omni{flex:1 1 0;height:auto;min-height:0;min-width:0;align-self:stretch;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:var(--ap-fs,12px);line-height:1.5} .cm-s-omni .CodeMirror-gutters{background:var(--bg);border-right:1px solid var(--line)} .cm-s-omni .CodeMirror-linenumber{color:var(--dim2)} .cm-s-omni .CodeMirror-cursor{border-left:1px solid var(--text)} .cm-s-omni .CodeMirror-selected{background:rgba(79,140,255,.2) !important} .cm-s-omni .CodeMirror-matchingbracket{color:var(--acc2) !important;text-decoration:underline} .cm-s-omni.CodeMirror-focused .CodeMirror-selected{background:rgba(79,140,255,.28) !important} .cm-s-omni .CodeMirror-activeline-background{background:rgba(255,255,255,.03)} .cm-s-omni .CodeMirror-lines{padding:8px 0}
.cm-s-omni .cm-keyword{color:#c792ea} .cm-s-omni .cm-atom,.cm-s-omni .cm-number{color:#f78c6c} .cm-s-omni .cm-def,.cm-s-omni .cm-variable-2{color:#82aaff} .cm-s-omni .cm-variable{color:var(--text)} .cm-s-omni .cm-property{color:#80cbc4} .cm-s-omni .cm-operator{color:#89ddff} .cm-s-omni .cm-comment{color:#546e7a;font-style:italic} .cm-s-omni .cm-string,.cm-s-omni .cm-string-2{color:#c3e88d} .cm-s-omni .cm-meta,.cm-s-omni .cm-qualifier{color:#ffcb6b} .cm-s-omni .cm-builtin{color:#ffcb6b} .cm-s-omni .cm-tag{color:#f07178} .cm-s-omni .cm-attribute{color:#ffcb6b} .cm-s-omni .cm-error{color:var(--err)} .cm-s-omni .cm-searching{background:rgba(255,179,71,.35)}
#ap-edwrap{position:relative;flex:1 1 0;min-width:0;min-height:0;display:flex} #ap-edwrap .CodeMirror-scroll{min-height:100%}
#ap-lint{font-size:10px;color:var(--warn);border-bottom:1px solid var(--line)} #ap-lint[hidden]{display:none} #ap-lint-h{display:flex;gap:6px;align-items:center;padding:3px 8px;letter-spacing:.1em;text-transform:uppercase} #ap-lint-h span{flex:1} #ap-lint-b{margin:0;padding:2px 8px 5px;white-space:pre-wrap;max-height:96px;overflow:auto;font:inherit;color:var(--warn)}
#ap-edwrap{flex:1;display:flex;min-height:0;background:var(--bg);font-family:var(--mono);font-size:var(--ap-fs,12px);line-height:1.5}
#ap-gutter{margin:0;padding:10px 6px 10px 8px;text-align:right;color:var(--dim2);user-select:none;overflow:hidden;border-right:1px solid var(--line);font:inherit;line-height:inherit;min-width:2.5em} #apanel.no-gutter #ap-gutter{display:none}
#ap-editor{flex:1;width:100%;resize:none;border:0;outline:0;background:transparent;color:var(--text);font:inherit;line-height:inherit;padding:10px;tab-size:var(--ap-tab,2);white-space:pre;overflow:auto} #apanel.wrap #ap-editor{white-space:pre-wrap;word-break:break-word}
#ap-bar{display:flex;gap:6px;align-items:center;padding:5px 8px;border-top:1px solid var(--line);flex-wrap:wrap} #ap-state{flex:1;font-size:10px;color:var(--dim2);letter-spacing:.06em} #ap-pos{font-size:10px;color:var(--dim2)}
.act-btn.primary{border-color:var(--acc);color:var(--acc)}
#ap-ask{border-top:1px solid var(--line);background:var(--s0);flex-shrink:0}
#ap-ask-row{display:flex;gap:6px;align-items:flex-end;padding:6px 10px} #ap-ask-in{flex:1;resize:none;background:var(--bg);color:var(--text);border:1px solid var(--line2);font:inherit;font-size:12px;padding:6px 8px;line-height:1.4;max-height:120px} #ap-ask-in:focus{border-color:var(--acc);outline:0} #ap-ask-st{font-size:10px;color:var(--dim2);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;max-width:40%;overflow:hidden;text-overflow:ellipsis}
#ap-reply{border-bottom:1px solid var(--line);max-height:38vh;display:flex;flex-direction:column} #ap-reply[hidden]{display:none} #ap-reply-h{display:flex;gap:6px;align-items:center;padding:3px 10px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim2)} #ap-reply-h span{flex:1} #ap-reply-b{overflow:auto;padding:4px 12px 8px;font-size:12px}
#ap-prompt{position:absolute;left:50%;top:40%;transform:translateX(-50%);background:var(--s1);border:1px solid var(--acc);padding:10px;display:flex;gap:6px;z-index:5} #ap-prompt[hidden]{display:none} #ap-prompt input{background:var(--bg);color:var(--text);border:1px solid var(--line2);font:inherit;font-size:12px;padding:4px 6px;min-width:240px}
#ap-set{position:absolute;top:0;right:0;height:100%;width:min(380px,100vw);background:var(--s0);border-left:1px solid var(--line);z-index:6;display:flex;flex-direction:column;border-left:1px solid var(--line2)} #ap-set.closed{transform:translateX(105%)}
#ap-set-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--acc)}
#ap-set-b{overflow:auto;padding:6px 12px 24px} #ap-set-b section{padding:10px 0;border-bottom:1px solid var(--line)} #ap-set-b h4{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2);margin:0 0 8px;font-weight:500}
#ap-set-b label{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--text);padding:4px 0;flex-wrap:wrap} #ap-set-b label>input[type=checkbox]{order:-1;margin:0 8px 0 0;accent-color:var(--acc)} #ap-set-b label:has(input[type=checkbox]){justify-content:flex-start}
#ap-set-b select,#ap-set-b textarea{background:var(--s1);color:var(--text);border:1px solid var(--line2);font:inherit;font-size:12px;padding:4px 6px} #ap-set-b textarea{width:100%;resize:vertical;line-height:1.45;font-family:var(--mono);font-size:11px} #ap-set-b label:has(textarea){flex-direction:column;align-items:stretch}
#ap-set-b input[type=range]{flex:1;accent-color:var(--acc)} #ap-set-b output{min-width:36px;text-align:right;color:var(--dim);font-size:11px}
.app-card-edit{margin-left:6px}
#sb-artifacts{border-top:1px solid var(--line);padding:6px 0} #sb-artifacts .sb-h{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2);padding:2px 10px 4px} .sb-art{display:block;width:100%;text-align:left;background:none;border:0;color:var(--dim);font:inherit;font-size:10px;padding:3px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .sb-art:hover{color:var(--acc)}
@media (max-width:900px){#apanel{width:100vw !important} body.ap-open #main{margin-right:0}}
`;
