// Deterministic repairs for generated apps. The model writes files; this makes them RUN.
//
// Independently-generated files fail at the seams in a handful of mechanical ways that do not need
// another model call: a <script src> missing type="module", a name imported but not exported, a
// stylesheet that exists but is never linked, TypeScript syntax in a .js file. Each of those is a
// blank page. Healing them here is the difference between "the build finished" and "the app opens".
import { blankNonCode } from "./errors.ts";
import { lintArtifact, listFiles, safePath, saveMany, stripModuleSyntax, type ArtFile } from "./artifacts.ts";

export type HealResult = { files: ArtFile[]; changes: string[] };

const isJs = (p: string) => /\.m?js$/i.test(p);
const isHtml = (p: string) => /\.html?$/i.test(p);
const isCss = (p: string) => /\.css$/i.test(p);

function parses(src: string): boolean {
  try { new Function(stripModuleSyntax(src)); return true; } catch { return false; }
}

function isModuleSource(content: string): boolean {
  const code = blankNonCode(String(content ?? ""));
  return /^\s*import\s+[^(]/m.test(code) || /^\s*import\s*["']/m.test(code) || /^\s*export\s+(?:default|const|let|var|function|class|\{|\*)/m.test(code);
}

function dirOf(p: string): string {
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
}

function resolve(from: string, spec: string): string {
  const parts = (dirOf(from) + spec.replace(/^\.\//, "")).split("/");
  const o: string[] = [];
  for (const x of parts) {
    if (x === "..") o.pop();
    else if (x !== ".") o.push(x);
  }
  return o.join("/");
}

function namedExports(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of content.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const nm = part.trim().split(/\s+as\s+/);
      const exported = (nm[1] ?? nm[0]).trim();
      if (exported) names.add(exported);
    }
  }
  if (/^\s*export\s+default\b/m.test(content)) names.add("default");
  return names;
}

function topLevelNames(content: string): Set<string> {
  const code = blankNonCode(content);
  const names = new Set<string>();
  let depth = 0;
  const lines = code.split("\n");
  for (const line of lines) {
    const open = (line.match(/[{]/g) ?? []).length;
    const close = (line.match(/[}]/g) ?? []).length;
    if (depth === 0) {
      for (const re of [
        /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
        /^\s*class\s+([A-Za-z_$][\w$]*)/,
        /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
        /^\s*(?:const|let|var)\s*\{([^}]*)\}/,
      ]) {
        const m = line.match(re);
        if (!m) continue;
        for (const piece of String(m[1]).split(",")) {
          const id = piece.trim().replace(/\s+as\s+/, " ").split(/\s+/).pop()!.replace(/[=:].*$/, "").trim();
          if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
        }
      }
    }
    depth = Math.max(0, depth + open - close);
  }
  return names;
}

/** Strip the TypeScript that models actually emit into .js files — only kept when it makes a
 *  previously-unparseable file parse. Conservative on purpose: a wrong strip is a new bug. */
export function stripTypeScript(src: string): string {
  let s = String(src ?? "");
  s = s.replace(/\s+as\s+const\b/g, "");
  s = s.replace(/\s+as\s+[A-Za-z_$][\w$<>[\]|&.,\s]*(?=[,);=\s\n]|$)/g, "");
  s = s.replace(/\s+satisfies\s+[A-Za-z_$][\w$<>[\]|&.,\s]*/g, "");
  s = s.replace(/\b(?:public|private|protected|readonly|override|abstract|declare)\s+/g, "");
  s = s.replace(/^(\s*)(?:export\s+)?interface\s+[A-Za-z_$][\w$]*\s*\{[^}]*\}\s*$/gm, "");
  s = s.replace(/^(\s*)(?:export\s+)?interface\s+[A-Za-z_$][\w$]*[\s\S]*?\n\1\}\s*\n?/gm, "");
  s = s.replace(/^(\s*)(?:export\s+)?type\s+[A-Za-z_$][\w$]*[^=]*=\s*[^;]+;\s*$/gm, "");
  // `foo!` non-null assertion, not `!=` / `!==`
  s = s.replace(/([A-Za-z_$)])!(?!=)/g, "$1");
  // `: Type` after a binding in a param/decl — only the common primitive/ident forms
  s = s.replace(/(\b(?:const|let|var|function|class)\s+[A-Za-z_$][\w$]*|\(|,)\s*([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>[\]|&.,\s]*?(?=\s*(?:=|,|\)|\{|;))/g, "$1 $2");
  s = s.replace(/\)\s*:\s*[A-Za-z_$][\w$<>[\]|&.\s]+\s*(?=>|\{)/g, ") ");
  return s;
}

function healJs(files: ArtFile[], changes: string[]): void {
  for (const f of files) {
    if (!isJs(f.path) || f.content.startsWith("data:")) continue;
    if (parses(f.content)) continue;
    const stripped = stripTypeScript(f.content);
    if (stripped !== f.content && parses(stripped)) {
      f.content = stripped;
      changes.push(`${f.path}: stripped TypeScript syntax that would throw at parse time`);
    }
  }
}

function healExports(files: ArtFile[], changes: string[]): void {
  const js = files.filter((f) => isJs(f.path) && !f.content.startsWith("data:"));
  const needed = new Map<string, Set<string>>();
  for (const f of js) {
    for (const m of f.content.matchAll(/^\s*import\s+([^;]*?)\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm)) {
      const target = resolve(f.path, m[2].replace(/[?#].*$/, ""));
      const braces = m[1].match(/\{([^}]*)\}/);
      if (!braces) continue;
      for (const part of braces[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!needed.has(target)) needed.set(target, new Set());
        needed.get(target)!.add(name);
      }
    }
  }
  for (const f of js) {
    const want = needed.get(f.path);
    if (!want?.size) continue;
    const exported = namedExports(f.content);
    const defined = topLevelNames(f.content);
    const add: string[] = [];
    for (const name of want) {
      if (exported.has(name)) continue;
      if (!defined.has(name)) continue;
      add.push(name);
      exported.add(name);
    }
    if (!add.length) continue;
    f.content = f.content.replace(/\s*$/, "") + "\nexport { " + add.join(", ") + " };\n";
    changes.push(`${f.path}: exported ${add.join(", ")} (imported by a sibling but not exported)`);
  }
}

function healHtml(files: ArtFile[], changes: string[]): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const jsFiles = files.filter((f) => isJs(f.path) && !f.content.startsWith("data:"));
  const cssFiles = files.filter((f) => isCss(f.path) && !f.content.startsWith("data:"));

  for (const f of files) {
    if (!isHtml(f.path) || f.content.startsWith("data:")) continue;
    let html = f.content;
    const before = html;

    html = html.replace(/<script\b([^>]*)>/gi, (full, attrs: string) => {
      if (/\btype\s*=\s*["']module["']/i.test(attrs)) return full;
      const srcM = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (srcM) {
        const target = safePath(srcM[1].replace(/^\.\//, "").replace(/[?#].*$/, ""));
        const content = byPath.get(target)?.content;
        if (content === undefined || !isModuleSource(content)) return full;
        changes.push(`${f.path}: <script src="${srcM[1]}"> is an ES module — added type="module"`);
        return `<script type="module"${attrs}>`;
      }
      return full;
    });
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
      if (/\bsrc\s*=/i.test(attrs) || /\btype\s*=\s*["']module["']/i.test(attrs)) return full;
      if (!isModuleSource(body)) return full;
      changes.push(`${f.path}: inline <script> uses import/export — added type="module"`);
      return `<script type="module"${attrs}>${body}</script>`;
    });

    if (/<base\b/i.test(html)) {
      html = html.replace(/<base\b[^>]*>/gi, "");
      changes.push(`${f.path}: removed <base> tag (breaks relative URLs on any host that is not the pinned one)`);
    }

    html = html.replace(/(\s(?:src|href)\s*=\s*["'])\/artifact\/\d+\/([^"']+)/gi, (_m, pre: string, path: string) => {
      changes.push(`${f.path}: rewrote sandbox path /artifact/…/${path} to ./${path}`);
      return `${pre}./${path}`;
    });
    html = html.replace(/(\s(?:src|href)\s*=\s*["'])\/(?!\/)([^"']+)/gi, (_m, pre: string, path: string) => {
      changes.push(`${f.path}: rewrote root-absolute /${path} to ./${path}`);
      return `${pre}./${path}`;
    });

    if (!/<script\b/i.test(html) && jsFiles.length) {
      const entry = jsFiles.find((x) => /^(main|app|index|boot)\.m?js$/i.test(x.path)) ?? jsFiles[0];
      const tag = `<script type="module" src="./${entry.path}"></script>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `  ${tag}\n</body>`) : html + "\n" + tag;
      changes.push(`${f.path}: added missing <script type="module" src="./${entry.path}">`);
    }

    for (const css of cssFiles) {
      const linked = new RegExp(`href\\s*=\\s*["'](?:\\./)?${css.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(html);
      if (linked) continue;
      const tag = `<link rel="stylesheet" href="./${css.path}">`;
      if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `  ${tag}\n</head>`);
      else if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (h) => h + "\n  " + tag);
      else html = tag + "\n" + html;
      changes.push(`${f.path}: linked missing stylesheet ./${css.path}`);
    }

    if (!/<meta[^>]*charset/i.test(html) && /<head[\s>]/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (h) => h + '\n  <meta charset="utf-8">');
      changes.push(`${f.path}: added <meta charset="utf-8">`);
    }

    if (html !== before) f.content = html;
  }
}

/** Apply every mechanical repair. Returns a new file list (originals are not mutated) plus what changed. */
export function healArtifact(files: ArtFile[]): HealResult {
  const out = files.map((f) => ({ path: f.path, content: f.content }));
  const changes: string[] = [];
  healJs(out, changes);
  healExports(out, changes);
  healHtml(out, changes);
  return { files: out, changes: [...new Set(changes)].slice(0, 24) };
}

/** Heal the stored artifact in place. No-op when nothing needs changing. */
export async function healAndSave(session: string, id: number): Promise<{ changes: string[]; issues: string[] }> {
  const lf = await listFiles(id);
  if (!lf) return { changes: [], issues: ["artifact missing"] };
  const r = healArtifact(lf.files);
  const orig = new Map(lf.files.map((f) => [f.path, f.content]));
  const dirty = r.files.filter((f) => orig.get(f.path) !== f.content);
  if (dirty.length) await saveMany(session, id, "", dirty);
  const after = await listFiles(id);
  return { changes: r.changes, issues: after ? lintArtifact(after.files) : ["artifact missing after heal"] };
}

/** The file a lint issue names, or "" if it does not start with a path. */
export function issuePath(issue: string): string {
  const m = /^([^\s:]+):/.exec(String(issue ?? ""));
  return m ? m[1] : "";
}
