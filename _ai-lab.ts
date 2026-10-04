// @ts-ignore - Val.town HTTP val
export default async function invariantLab(req: Request): Promise<Response> {
  // ---------- Core epistemic types ----------
  type ProviderId = "openai" | "anthropic" | "groq" | "fireworks" | "together";

  type Provider = {
    id: ProviderId;
    label: string;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    kind: "openai-compatible" | "anthropic-messages";
  };

  type Strata = { syntactic: string; semantic: string; structural: string };

  type Technique = {
    id: string;
    name: string;
    goal: string;
    strata: Strata;
    bayesianDelta: string;
    invariants: string[];
    failureModes: string[];
    inputs: { key: string; label: string; hint: string }[];
    template: string;
    // post-processor: raw text → claim graph
    normalize: (raw: string, providerId: ProviderId) => ClaimGraph;
  };

  type Claim = {
    id: string; // local identifier
    providerId: ProviderId; // source
    proposition: string; // canonicalized statement
    support?: string; // optional reference
  };

  type ClaimGraph = {
    providerId: ProviderId;
    claims: Claim[];
  };

  type Invariant = {
    key: string; // canonical proposition key
    text: string; // representative text
    providers: ProviderId[]; // who agrees
  };

  type Disagreement = {
    key: string;
    variants: { providerId: ProviderId; text: string }[];
  };

  type RunResult = {
    providerId: ProviderId;
    label: string;
    model: string;
    ok: boolean;
    content?: string;
    error?: string;
    graph?: ClaimGraph;
  };

  // ---------- Provider registry ----------
  const PROVIDERS: Provider[] = [
    {
      id: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4.1-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      kind: "openai-compatible",
    },
    {
      id: "anthropic",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1/messages",
      model: "claude-3-5-sonnet-20241022",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      kind: "anthropic-messages",
    },
    {
      id: "groq",
      label: "Groq",
      baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      apiKeyEnv: "GROQ_API_KEY",
      kind: "openai-compatible",
    },
    {
      id: "fireworks",
      label: "Fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
      model: "accounts/fireworks/models/deepseek-v4-pro",
      apiKeyEnv: "FIREWORKS_API_KEY",
      kind: "openai-compatible",
    },
    {
      id: "together",
      label: "Together",
      baseUrl: "https://api.together.xyz/v1/chat/completions",
      model: "deepseek-ai/DeepSeek-V4-Pro",
      apiKeyEnv: "TOGETHER_API_KEY",
      kind: "openai-compatible",
    },
  ];

  function getProvider(id: string | null): Provider | null {
    return PROVIDERS.find((p) => p.id === id) ?? null;
  }

  // ---------- Normalization helpers ----------
  function normalizeJsonClaims(
    raw: string,
    providerId: ProviderId,
  ): ClaimGraph {
    // Expect JSON with "claims": [{ "proposition": "...", "support": "..." }]
    try {
      const data = JSON.parse(raw);
      const arr = Array.isArray(data.claims) ? data.claims : [];
      const claims: Claim[] = arr.map((c: any, idx: number) => ({
        id: `${providerId}-c${idx}`,
        providerId,
        proposition: String(c.proposition ?? "").trim(),
        support: c.support ? String(c.support) : undefined,
      })).filter((c) => c.proposition.length > 0);
      return { providerId, claims };
    } catch {
      // Fallback: treat whole text as one opaque claim
      return {
        providerId,
        claims: raw.trim()
          ? [{ id: `${providerId}-c0`, providerId, proposition: raw.trim() }]
          : [],
      };
    }
  }

  // ---------- Technique registry (now with normalize) ----------
  const TECHNIQUES: Technique[] = [
    {
      id: "triangulated_invariants",
      name: "Model‑Stack Invariant Extraction",
      goal:
        "Extract architecture‑agnostic conceptual primitives from disagreeing models.",
      strata: {
        syntactic:
          "JSON envelope with 'claims' array; each claim has 'proposition' and optional 'support'.",
        semantic:
          "Each model emits atomic propositions about the task; invariants are cross‑model intersections.",
        structural:
          "Provider outputs → claim graphs → invariant set + disagreement spectra.",
      },
      bayesianDelta:
        "Disagreement curvature is approximated by how many providers diverge per proposition key; invariants are propositions with maximal provider coverage.",
      invariants: [
        "All providers are forced into the same claim schema.",
        "Intersection is computed over canonicalized proposition keys.",
        "Opaque outputs degrade to single coarse claims but remain in the graph.",
      ],
      failureModes: [
        "Providers ignore JSON instruction and emit prose only.",
        "Propositions are too coarse, collapsing distinct claims.",
        "Canonicalization is too aggressive, merging non‑equivalent statements.",
      ],
      inputs: [
        { key: "NODE_ID", label: "Node ID", hint: "e.g. node‑1" },
        { key: "PROBLEM", label: "Problem", hint: "Task to solve" },
        { key: "CONSTRAINTS", label: "Constraints", hint: "Hard requirements" },
      ],
      template: `You are one node in a MODEL ENSEMBLE.

ROLE:
- Node ID: {NODE_ID}
- You reason independently, then expose your internal structure.

TASK:
- Problem: {PROBLEM}
- Constraints: {CONSTRAINTS}

OUTPUT (JSON ONLY, no comments or commentary, no code fences):
{
  "node_id": "{NODE_ID}",
  "answer": "...",
  "reasoning": ["step 1", "step 2", "..."],
  "claims": [
    { "proposition": "atomic statement 1", "support": "step index or rationale" },
    { "proposition": "atomic statement 2", "support": "..." }
  ],
  "uncertainty": "low|medium|high",
  "expected_disagreements": ["...", "..."]
}`,
      normalize: normalizeJsonClaims,
    },
    {
      id: "synthetic_expert_contract",
      name: "Synthetic‑Expert Contract Canonization",
      goal: "Turn a domain into a reusable, auditable expert contract.",
      strata: {
        syntactic:
          "JSON with 'priors', 'methods', 'known_blind_spots', 'calibration_rituals', 'disclosure_policy'.",
        semantic:
          "Each field is a structured claim family about epistemic behavior.",
        structural:
          "Contract fields → claim families → invariants across providers for expert behavior.",
      },
      bayesianDelta:
        "Invariants across providers define the stable epistemic skeleton of the expert; disagreements reveal model‑specific epistemic biases.",
      invariants: [
        "Contract fields are mapped to proposition prefixes (e.g. 'prior:', 'method:').",
        "Cross‑provider agreement on blind spots is especially high‑value.",
        "Calibration rituals are treated as meta‑claims about reliability.",
      ],
      failureModes: [
        "Providers emit narrative instead of structured lists.",
        "Fields are left empty, reducing claim density.",
        "Different providers use incompatible granularity.",
      ],
      inputs: [
        {
          key: "DOMAIN",
          label: "Domain",
          hint: "e.g. municipal drainage compliance",
        },
      ],
      template: `You are defining a SYNTHETIC EXPERT.

DOMAIN:
- {DOMAIN}

TASK:
- Produce a reusable expert contract.

OUTPUT (JSON ONLY):
{
  "name": "Synthetic {DOMAIN} Expert",
  "epistemic_stance": ["..."],
  "priors": ["default assumptions about the world in this domain"],
  "methods": ["core reasoning and evidence‑gathering methods"],
  "known_blind_spots": ["where this expert is unreliable"],
  "calibration_rituals": ["how it checks itself when uncertain"],
  "disclosure_policy": ["what it must always state explicitly to the user"],
  "operating_contract": [
    "binding rules for how this expert answers questions in {DOMAIN}"
  ]
}`,
      normalize(raw: string, providerId: ProviderId): ClaimGraph {
        try {
          const data = JSON.parse(raw);
          const claims: Claim[] = [];
          const pushList = (prefix: string, arr: any[]) => {
            arr.forEach((v, idx) => {
              const text = String(v ?? "").trim();
              if (!text) return;
              claims.push({
                id: `${providerId}-${prefix}-${idx}`,
                providerId,
                proposition: `${prefix}: ${text}`,
              });
            });
          };
          if (Array.isArray(data.priors)) pushList("prior", data.priors);
          if (Array.isArray(data.methods)) pushList("method", data.methods);
          if (Array.isArray(data.known_blind_spots)) {
            pushList("blind_spot", data.known_blind_spots);
          }
          if (Array.isArray(data.calibration_rituals)) {
            pushList("calibration", data.calibration_rituals);
          }
          if (Array.isArray(data.disclosure_policy)) {
            pushList("disclosure", data.disclosure_policy);
          }
          if (Array.isArray(data.operating_contract)) {
            pushList("contract", data.operating_contract);
          }
          return { providerId, claims };
        } catch {
          return normalizeJsonClaims(raw, providerId);
        }
      },
    },
  ];

  function getTechnique(id: string | null): Technique | null {
    return TECHNIQUES.find((t) => t.id === id) ?? null;
  }

  function synthPrompt(t: Technique, inputs: Record<string, string>): string {
    let text = t.template;
    for (const inp of t.inputs) {
      const val = inputs[inp.key] ?? "";
      const re = new RegExp("\\{" + inp.key + "\\}", "g");
      text = text.replace(re, val);
    }
    return text;
  }

  // ---------- Provider calls ----------
  async function callProvider(
    provider: Provider,
    prompt: string,
  ): Promise<{ content: string; raw: any }> {
    const apiKey = Deno.env.get(provider.apiKeyEnv) as
      | string
      | undefined;
    if (!apiKey) throw new Error(`Missing API key env: ${provider.apiKeyEnv}`);

    if (provider.kind === "openai-compatible") {
      const res = await fetch(provider.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `Provider error (${provider.id}): ${res.status} ${errText}`,
        );
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content?.toString() ??
        JSON.stringify(data, null, 2);
      return { content, raw: data };
    }

    if (provider.kind === "anthropic-messages") {
      const res = await fetch(provider.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `Provider error (${provider.id}): ${res.status} ${errText}`,
        );
      }
      const data = await res.json();
      const content = data.content?.[0]?.text?.toString() ??
        JSON.stringify(data, null, 2);
      return { content, raw: data };
    }

    throw new Error(`Unsupported provider kind: ${provider.kind}`);
  }

  // ---------- Invariant and disagreement computation ----------
  function canonicalKey(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
  }

  function computeInvariants(graphs: ClaimGraph[]): {
    invariants: Invariant[];
    disagreements: Disagreement[];
  } {
    const map: Record<
      string,
      { texts: { providerId: ProviderId; text: string }[] }
    > = {};
    for (const g of graphs) {
      for (const c of g.claims) {
        const key = canonicalKey(c.proposition);
        if (!map[key]) map[key] = { texts: [] };
        map[key].texts.push({ providerId: g.providerId, text: c.proposition });
      }
    }

    const invariants: Invariant[] = [];
    const disagreements: Disagreement[] = [];

    for (const [key, bucket] of Object.entries(map)) {
      const providers = Array.from(
        new Set(bucket.texts.map((t) => t.providerId)),
      );
      if (providers.length > 1) {
        // multi‑provider region: invariant core + disagreement surface
        const rep = bucket.texts[0]?.text ?? key;
        invariants.push({ key, text: rep, providers });
        const uniqueTexts = Array.from(
          new Map(bucket.texts.map((t) => [t.text, t])).values(),
        );
        if (uniqueTexts.length > 1) {
          disagreements.push({
            key,
            variants: uniqueTexts,
          });
        }
      }
    }

    return { invariants, disagreements };
  }

  // ---------- Routing ----------
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "html";

  // Registry
  if (mode === "registry") {
    return new Response(
      JSON.stringify(
        {
          providers: PROVIDERS.map((p) => ({
            id: p.id,
            label: p.label,
            model: p.model,
            kind: p.kind,
          })),
          techniques: TECHNIQUES.map((t) => ({
            id: t.id,
            name: t.name,
            goal: t.goal,
            strata: t.strata,
            bayesianDelta: t.bayesianDelta,
            invariants: t.invariants,
            failureModes: t.failureModes,
            inputs: t.inputs,
          })),
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  // Run experiment
  if (mode === "run" && req.method === "POST") {
    try {
      const body = await req.json();
      const techniqueId = body.techniqueId as string | undefined;
      const providerIds = (body.providerIds as string[] | undefined) ?? [];
      const inputs = (body.inputs as Record<string, string> | undefined) ?? {};

      const tech = getTechnique(techniqueId ?? null);
      if (!tech) {
        return new Response(
          JSON.stringify({ error: "unknown technique", techniqueId }, null, 2),
          {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }

      const selectedProviders = providerIds.length > 0
        ? providerIds
          .map((id: string) => getProvider(id))
          .filter((p): p is Provider => !!p)
        : PROVIDERS;

      const prompt = synthPrompt(tech, inputs);

      const runResults: RunResult[] = [];
      for (const p of selectedProviders) {
        try {
          const out = await callProvider(p, prompt);
          const graph = tech.normalize(out.content, p.id);
          runResults.push({
            providerId: p.id,
            label: p.label,
            model: p.model,
            ok: true,
            content: out.content,
            graph,
          });
        } catch (e: any) {
          runResults.push({
            providerId: p.id,
            label: p.label,
            model: p.model,
            ok: false,
            error: e?.message ?? String(e),
          });
        }
      }

      const graphs = runResults
        .filter((r) => r.ok && r.graph)
        .map((r) => r.graph as ClaimGraph);

      const { invariants, disagreements } = computeInvariants(graphs);

      return new Response(
        JSON.stringify(
          {
            techniqueId: tech.id,
            prompt,
            results: runResults,
            invariantLayer: {
              invariants,
              disagreements,
            },
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: e?.message ?? String(e) }, null, 2),
        {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }
  }

  // ---------- Minimal UI: inputs → run → invariants ----------
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Invariant Lab · Multi‑Provider Claim Manifold</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
:root {
  color-scheme: dark;
  --bg: #050509;
  --fg: #f5f5f7;
  --accent: #5cf2c8;
  --muted: #8b8b99;
  --border: #26263a;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 12px;
  font-family: var(--sans);
  background: radial-gradient(circle at top, #181832 0, var(--bg) 55%);
  color: var(--fg);
}
main {
  max-width: 1120px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
header { display: flex; flex-direction: column; gap: 4px; }
h1 {
  font-size: 1.1rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 0;
}
.subtitle { font-size: 0.78rem; color: var(--muted); }
.layout { display: flex; flex-direction: column; gap: 8px; }
@media (min-width: 900px) {
  .layout { flex-direction: row; align-items: stretch; }
}
.sidebar { flex: 0 0 260px; display: flex; flex-direction: column; gap: 6px; }
.tech-list {
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 6px;
  max-height: 420px;
  overflow: auto;
}
.tech-item {
  border-radius: 7px;
  padding: 5px 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tech-item:hover { background: rgba(255,255,255,0.04); }
.tech-id {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--muted);
}
.tech-name { font-size: 0.8rem; color: var(--accent); }
.tech-goal { font-size: 0.74rem; color: var(--muted); }
.providers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.provider-pill {
  border-radius: 999px;
  border: 1px solid var(--border);
  padding: 2px 8px;
  font-size: 0.7rem;
  cursor: pointer;
}
.provider-pill.selected {
  border-color: rgba(92,242,200,0.7);
  background: rgba(92,242,200,0.08);
  color: var(--accent);
}
.panel {
  flex: 1;
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-title {
  font-size: 0.76rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.panel-name { font-family: var(--mono); font-size: 0.86rem; color: var(--accent); }
.panel-goal { font-size: 0.78rem; }
.inputs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.input-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.input-row label {
  font-size: 0.72rem;
  color: var(--muted);
}
.input-row input {
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #05050b;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 0.76rem;
  padding: 4px 6px;
}
textarea {
  width: 100%;
  min-height: 110px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #05050b;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 0.76rem;
  padding: 6px;
  resize: vertical;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
button {
  border-radius: 999px;
  border: 1px solid rgba(92,242,200,0.4);
  background: transparent;
  color: var(--accent);
  font-size: 0.74rem;
  padding: 3px 9px;
  cursor: pointer;
}
button:hover { background: rgba(92,242,200,0.08); }
.small { font-size: 0.7rem; color: var(--muted); }
.grid {
  display: grid;
  grid-template-columns: minmax(0,1fr);
  gap: 6px;
}
@media (min-width: 900px) {
  .grid { grid-template-columns: minmax(0,1.1fr) minmax(0,1.1fr); }
}
.box {
  border-radius: 6px;
  border: 1px solid var(--border);
  padding: 6px;
  font-size: 0.76rem;
}
.box-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 2px;
}
ul { margin: 2px 0 0; padding-left: 14px; }
li { font-size: 0.76rem; margin-bottom: 2px; }
.results {
  max-height: 220px;
  overflow: auto;
  background: #05050b;
  border-radius: 6px;
  border: 1px solid var(--border);
  padding: 6px;
  font-size: 0.74rem;
}
.result-block { border-bottom: 1px solid #222235; padding: 4px 0; }
.result-header { font-size: 0.7rem; color: var(--muted); margin-bottom: 2px; }
.result-content { white-space: pre-wrap; font-family: var(--mono); }
.invariants {
  max-height: 180px;
  overflow: auto;
  background: #05050b;
  border-radius: 6px;
  border: 1px solid var(--border);
  padding: 6px;
  font-size: 0.74rem;
}
.inv-block { border-bottom: 1px solid #222235; padding: 3px 0; }
.inv-key { font-size: 0.7rem; color: var(--muted); }
.inv-text { font-size: 0.74rem; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Invariant Lab</h1>
    <div class="subtitle">Multi‑provider claim graphs · invariants · disagreement spectra · ?mode=registry for JSON</div>
  </header>
  <section class="layout">
    <aside class="sidebar">
      <div class="subtitle">Techniques</div>
      <div class="tech-list" id="tech-list">
        ${
    TECHNIQUES.map(
      (t) => `
        <div class="tech-item" data-id="${t.id}">
          <div class="tech-id">${t.id}</div>
          <div class="tech-name">${t.name}</div>
          <div class="tech-goal">${t.goal}</div>
        </div>`,
    ).join("")
  }
      </div>
      <div class="subtitle" style="margin-top:6px;">Providers</div>
      <div class="providers" id="providers">
        ${
    PROVIDERS.map(
      (p) => `
        <div class="provider-pill selected" data-id="${p.id}">
          ${p.id} · ${p.model}
        </div>`,
    ).join("")
  }
      </div>
    </aside>
    <section class="panel">
      <div class="panel-title">Technique</div>
      <div class="panel-name" id="name">${TECHNIQUES[0].name}</div>
      <div class="panel-goal" id="goal">${TECHNIQUES[0].goal}</div>
      <div class="grid">
        <div class="box">
          <div class="box-title">Strata</div>
          <ul id="strata">
            <li><strong>Syntactic:</strong> ${
    TECHNIQUES[0].strata.syntactic
  }</li>
            <li><strong>Semantic:</strong> ${TECHNIQUES[0].strata.semantic}</li>
            <li><strong>Structural:</strong> ${
    TECHNIQUES[0].strata.structural
  }</li>
          </ul>
        </div>
        <div class="box">
          <div class="box-title">Bayesian Δ & Invariants</div>
          <div id="delta" style="margin-bottom:4px;">${
    TECHNIQUES[0].bayesianDelta
  }</div>
          <ul id="inv-notes">
            ${TECHNIQUES[0].invariants.map((x) => `<li>${x}</li>`).join("")}
          </ul>
        </div>
      </div>
      <div class="box">
        <div class="box-title">Inputs & Prompt</div>
        <div class="inputs" id="inputs"></div>
        <textarea id="prompt">${TECHNIQUES[0].template}</textarea>
        <div class="toolbar">
          <span class="small">Fill inputs → Run → inspect invariants.</span>
          <div>
            <button id="run">Run</button>
            <button id="copy">Copy</button>
          </div>
        </div>
      </div>
      <div class="grid">
        <div class="box">
          <div class="box-title">Provider outputs</div>
          <div class="results" id="results"></div>
        </div>
        <div class="box">
          <div class="box-title">Invariant layer</div>
          <div class="invariants" id="inv-layer"></div>
        </div>
      </div>
    </section>
  </section>
</main>
<script>
(function() {
  const techniques = ${
    JSON.stringify(
      TECHNIQUES.map((t) => ({
        id: t.id,
        name: t.name,
        goal: t.goal,
        strata: t.strata,
        bayesianDelta: t.bayesianDelta,
        invariants: t.invariants,
        inputs: t.inputs,
        template: t.template,
      })),
    )
  };
  const providers = ${
    JSON.stringify(
      PROVIDERS.map((p) => ({ id: p.id, label: p.label, model: p.model })),
    )
  };

  const techList = document.getElementById("tech-list");
  const providersEl = document.getElementById("providers");
  const nameEl = document.getElementById("name");
  const goalEl = document.getElementById("goal");
  const strataEl = document.getElementById("strata");
  const deltaEl = document.getElementById("delta");
  const invNotesEl = document.getElementById("inv-notes");
  const inputsEl = document.getElementById("inputs");
  const promptEl = document.getElementById("prompt");
  const runBtn = document.getElementById("run");
  const copyBtn = document.getElementById("copy");
  const resultsEl = document.getElementById("results");
  const invLayerEl = document.getElementById("inv-layer");

  let current = techniques[0];

  function renderInputs() {
    inputsEl.innerHTML = current.inputs
      .map(
        (inp) => \`
      <div class="input-row">
        <label for="inp-\${inp.key}">\${inp.label} <span style="opacity:0.7;">(\${inp.key})</span></label>
        <input id="inp-\${inp.key}" data-key="\${inp.key}" placeholder="\${inp.hint}" />
      </div>\`
      )
      .join("");
  }

  function renderTechnique(t) {
    current = t;
    nameEl.textContent = t.name;
    goalEl.textContent = t.goal;
    strataEl.innerHTML = [
      "<li><strong>Syntactic:</strong> " + t.strata.syntactic + "</li>",
      "<li><strong>Semantic:</strong> " + t.strata.semantic + "</li>",
      "<li><strong>Structural:</strong> " + t.strata.structural + "</li>"
    ].join("");
    deltaEl.textContent = t.bayesianDelta;
    invNotesEl.innerHTML = t.invariants.map((x) => "<li>" + x + "</li>").join("");
    promptEl.value = t.template;
    renderInputs();
    resultsEl.innerHTML = "";
    invLayerEl.innerHTML = "";
  }

  function getSelectedProviders() {
    const pills = providersEl.querySelectorAll(".provider-pill");
    const ids = [];
    pills.forEach((p) => {
      if (p.classList.contains("selected")) {
        ids.push(p.getAttribute("data-id"));
      }
    });
    return ids.filter(Boolean);
  }

  function gatherInputs() {
    const obj = {};
    current.inputs.forEach((inp) => {
      const el = document.getElementById("inp-" + inp.key);
      obj[inp.key] = (el && el.value) || "";
    });
    return obj;
  }

  techList.addEventListener("click", (e) => {
    const target = (e.target).closest(".tech-item");
    if (!target) return;
    const id = target.getAttribute("data-id");
    const t = techniques.find((x) => x.id === id);
    if (!t) return;
    renderTechnique(t);
  });

  providersEl.addEventListener("click", (e) => {
    const pill = (e.target).closest(".provider-pill");
    if (!pill) return;
    pill.classList.toggle("selected");
  });

  runBtn.addEventListener("click", async () => {
    const providerIds = getSelectedProviders();
    if (providerIds.length === 0) {
      alert("Select at least one provider.");
      return;
    }
    const inputs = gatherInputs();
    resultsEl.innerHTML = '<div class="result-block"><div class="result-header">Running...</div></div>';
    invLayerEl.innerHTML = "";
    try {
      const res = await fetch("?mode=run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          techniqueId: current.id,
          providerIds,
          inputs
        })
      });
      const data = await res.json();
      promptEl.value = data.prompt || promptEl.value;
      if (!res.ok) {
        resultsEl.innerHTML =
          '<div class="result-block"><div class="result-header">Error</div><div class="result-content">' +
          (data.error || "Unknown error") +
          "</div></div>";
        return;
      }
      resultsEl.innerHTML = (data.results || [])
        .map(
          (r) =>
            '<div class="result-block">' +
            '<div class="result-header">' +
            r.providerId +
            " · " +
            r.model +
            (r.ok ? "" : " · ERROR") +
            "</div>" +
            '<div class="result-content">' +
            (r.ok ? r.content : r.error) +
            "</div></div>"
        )
        .join("");

      const inv = data.invariantLayer || { invariants: [], disagreements: [] };
      const invBlocks = [];
      (inv.invariants || []).forEach((iv) => {
        invBlocks.push(
          '<div class="inv-block">' +
            '<div class="inv-key">Invariant · providers: ' +
            (iv.providers || []).join(", ") +
            "</div>" +
            '<div class="inv-text">' +
            iv.text +
            "</div>" +
          "</div>"
        );
      });
      (inv.disagreements || []).forEach((d) => {
        invBlocks.push(
          '<div class="inv-block">' +
            '<div class="inv-key">Disagreement on key: ' +
            d.key +
            "</div>" +
            '<div class="inv-text">' +
            (d.variants || [])
              .map((v) => v.providerId + ": " + v.text)
              .join(" | ") +
            "</div>" +
          "</div>"
        );
      });
      invLayerEl.innerHTML = invBlocks.join("") || "<div class='inv-block'><div class='inv-text'>No multi‑provider invariants detected.</div></div>";
    } catch (e) {
      resultsEl.innerHTML =
        '<div class="result-block"><div class="result-header">Client error</div><div class="result-content">' +
        String(e) +
        "</div></div>";
    }
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(promptEl.value);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 900);
    } catch {
      copyBtn.textContent = "Copy failed";
      setTimeout(() => (copyBtn.textContent = "Copy"), 900);
    }
  });

  renderTechnique(current);
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}