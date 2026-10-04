// Dependency-free Markdown → safe HTML for the chat body. Text is escaped
// before any tag is emitted, so only renderer-generated tags exist in the
// output. Fences → <div class="cb"> (lang · lines · copy). Unterminated fences
// (mid-stream) still render as code. Math ($$…$$, \(…\), $…$) → .mx for KaTeX.
// No backtick appears in this template: \x60 is used inside regex sources.
export const markdownScript: string = String.raw`
const MD = (() => {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => /^(https?:|mailto:|#|\/)/i.test(u.trim()) ? u.trim() : "#";
  const ALIAS = { js: "javascript", ts: "typescript", py: "python", sh: "bash", shell: "bash", zsh: "bash", yml: "yaml", cs: "csharp", "c#": "csharp", rs: "rust", md: "markdown", jsx: "javascript", tsx: "typescript", ps1: "powershell", txt: "plaintext", text: "plaintext", "": "plaintext" };
  const FENCE = /^\s*(\x60\x60\x60+|~~~+)\s*([\w#+.-]*)/;
  const SPAN = /(\x60+)([^\x60]|[^\x60][\s\S]*?[^\x60])\1(?!\x60)/g;
  const S0 = "\uE000", S1 = "\uE001";

  function inline(s) {
    const slots = [];
    const keep = (html) => { slots.push(html); return S0 + (slots.length - 1) + S1; };
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => keep('<span class="mx mx-d">' + esc(m) + "</span>"));
    s = s.replace(/\\\((.+?)\\\)/g, (_, m) => keep('<span class="mx">' + esc(m) + "</span>"));
    s = s.replace(/(^|[^\w$\\])\$([^\s$][^$\n]*?[^\s$\\]|[^\s$\\])\$(?![\w$])/g, (_, pre, m) => pre + keep('<span class="mx">' + esc(m) + "</span>"));
    s = s.replace(SPAN, (_, _t, m) => keep("<code>" + esc(m.trim()) + "</code>"));
    s = esc(s);
    // u came from matching against \`s\`, which was already globally esc()'d three lines up — esc()-ing it
    // again here double-encoded every &, producing e.g. href="...a=1&amp;amp;b=2" (a browser attribute-decodes
    // that back to the literal, wrong string "...a=1&amp;b=2", not the intended "...a=1&b=2"). safeUrl(u) is
    // already escaped text at this point; the plain-autolink regex three lines below never double-escapes for
    // the same reason and is the correct pattern to match.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, u) => '<a class="img" href="' + safeUrl(u) + '" target="_blank" rel="noopener">[img: ' + (alt || u) + "]</a>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener">' + t + "</a>");
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<.,;:!?)])/g, (_, pre, u) => pre + '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>");
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
    s = s.replace(/(^|[^*\w])\*(\S(?:[^*\n]*?\S)?)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^_\w])_(\S(?:[^_\n]*?\S)?)_(?!\w)/g, "$1<i>$2</i>");
    s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
    return s.replace(/\uE000(\d+)\uE001/g, (_, i) => slots[+i]);
  }

  function codeBlock(lang, code) {
    const l = ALIAS[lang.toLowerCase()] || lang.toLowerCase();
    const n = code.split("\n").length;
    return '<div class="cb"><div class="cb-h"><span class="cb-lang">' + esc(l) + '</span><span class="cb-n">' + n + (n === 1 ? " line" : " lines") +
      '</span><button class="cb-copy" type="button" onclick="MD.copy(this)">copy</button></div><pre><code class="language-' + esc(l) + '">' + esc(code) + "</code></pre></div>";
  }

  function table(rows) {
    const cells = (r) => r.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => inline(c.trim()));
    const align = rows[1].replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => /^\s*:-+:\s*$/.test(c) ? "center" : /^\s*-+:\s*$/.test(c) ? "right" : "");
    const td = (tag, c, i) => "<" + tag + (align[i] ? ' style="text-align:' + align[i] + '"' : "") + ">" + c + "</" + tag + ">";
    let h = '<div class="tbl"><table><thead><tr>' + cells(rows[0]).map((c, i) => td("th", c, i)).join("") + "</tr></thead><tbody>";
    for (const r of rows.slice(2)) h += "<tr>" + cells(r).map((c, i) => td("td", c, i)).join("") + "</tr>";
    return h + "</tbody></table></div>";
  }

  const indent = (l) => l.match(/^\s*/)[0].length;
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function blocks(lines) {
    let out = "", i = 0;
    const para = [];
    const flush = () => { if (para.length) { out += "<p>" + inline(para.join("\n")) + "</p>"; para.length = 0; } };
    while (i < lines.length) {
      const ln = lines[i];
      let m;
      if ((m = ln.match(FENCE))) {
        flush();
        const fence = m[1], buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        out += codeBlock(m[2] || "", buf.join("\n"));
        continue;
      }
      if (!ln.trim()) { flush(); i++; continue; }
      if ((m = ln.match(/^(#{1,6})\s+(.+?)\s*#*$/))) { flush(); out += "<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"; i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flush(); out += "<hr>"; i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        out += table(rows);
        continue;
      }
      if (/^\s*>/.test(ln)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        out += "<blockquote>" + blocks(buf) + "</blockquote>";
        continue;
      }
      if ((m = ln.match(LI))) {
        flush();
        const base = m[1].length, ordered = /\d/.test(m[2]), items = [];
        while (i < lines.length) {
          const mm = lines[i].match(LI);
          if (mm && mm[1].length === base) { if (/\d/.test(mm[2]) !== ordered) break; items.push([mm[3]]); i++; continue; }
          if (items.length && (lines[i].trim() ? indent(lines[i]) > base : i + 1 < lines.length && lines[i + 1].trim() && indent(lines[i + 1]) > base)) {
            items[items.length - 1].push(lines[i].slice(Math.min(indent(lines[i]), base + 2)));
            i++; continue;
          }
          break;
        }
        const tag = ordered ? "ol" : "ul";
        out += "<" + tag + ">" + items.map((it) => {
          const ck = it[0].match(/^\[([ xX])\]\s+/);
          const first = ck ? '<span class="ck' + (ck[1] === " " ? "" : " on") + '"></span>' + inline(it[0].slice(ck[0].length)) : inline(it[0]);
          return "<li>" + first + (it.length > 1 ? blocks(it.slice(1)) : "") + "</li>";
        }).join("") + "</" + tag + ">";
        continue;
      }
      para.push(ln);
      i++;
    }
    flush();
    return out;
  }

  const render = (src) => blocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"));

  function copy(btn) {
    const code = btn.closest(".cb").querySelector("code").textContent;
    navigator.clipboard.writeText(code).then(() => { btn.textContent = "copied"; setTimeout(() => (btn.textContent = "copy"), 1200); });
  }

  const loaded = {};
  const load = (id, js, css) => loaded[id] ??= new Promise((res, rej) => {
    if (css) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = css; document.head.appendChild(l); }
    const s = document.createElement("script"); s.src = js; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  async function enhance(el) {
    if (el.querySelector("pre code")) {
      try {
        await load("hljs", "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js");
        el.querySelectorAll("pre code:not(.hljs)").forEach((c) => window.hljs.highlightElement(c));
      } catch {}
    }
    if (el.querySelector(".mx")) {
      try {
        await load("katex", "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js", "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css");
        el.querySelectorAll(".mx:not(.done)").forEach((x) => { try { window.katex.render(x.textContent, x, { displayMode: x.classList.contains("mx-d"), throwOnError: false }); x.classList.add("done"); } catch {} });
      } catch {}
    }
  }
  return { render, copy, enhance, esc };
})();
window.MD = MD;
`;
