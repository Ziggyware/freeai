import { salvageArtifactArgs } from "./app-helpers.ts";
const cut = '{"id": 59, "files": [{"path": "style.css", "content": ":root{--bg:#000}\\nbody{margin:0}"}, {"path": "store.js", "content": "export function createStore(r, i) {\\n  let s = i;\\n  return { get: () => s };\\n}"}, {"path": "render.js", "content": "import { get } from \'./store.js\';\\nconst c = document.getElementById(\'c\');\\nfunction draw() { c.getContext';
const r = salvageArtifactArgs(cut);
console.log(JSON.stringify({ saved: r?.saved, cut: r?.cut, id: r?.args.id, store: (r?.args.files as any)?.[1]?.content.slice(0, 30) }));
const cut2 = '{"title": "Novel AI Chat", "kind": "html", "content": "<!doctype html><html><body><h1>x</h1></body></html>", "files": [{"path": "a.js", "content": "const a = 1; // cut here';
const r2 = salvageArtifactArgs(cut2); console.log(JSON.stringify({ saved: r2?.saved, cut: r2?.cut, title: r2?.args.title, hasContent: "content" in (r2?.args ?? {}) }));
console.log("none:", salvageArtifactArgs('{"id": 3, "files": [{"path": "x.js", "con'));
