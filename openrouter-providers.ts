// openrouter-providers.ts — ~450 chars
interface OpenRouterProvider {
  model: string;
  context: number;
  tier: number; // 1=primary, 2=fallback, 3=tertiary
  costPerMToken?: [number, number]; // [input, output] or undefined if free
  requestsPerDay: number;
  expiryDate?: Date; // e.g., new Date('2026-07-21') for Tencent Hy3
  capabilities: ("reasoning" | "coding" | "multimodal" | "tool-use")[];
}

export const OPENROUTER_FREE: Record<string, OpenRouterProvider> = {
  "nvidia/nemotron-3-ultra": {
    model: "nvidia/nemotron-3-ultra",
    context: 1_000_000,
    tier: 1,
    requestsPerDay: 1000,
    capabilities: ["reasoning", "coding", "tool-use"],
  },
  "qwen/qwen3-coder": {
    model: "qwen/qwen3-coder",
    context: 1_000_000,
    tier: 1,
    requestsPerDay: 1000,
    capabilities: ["coding", "tool-use"],
  },
  "openai/gpt-oss-120b": {
    model: "openai/gpt-oss-120b",
    context: 131_072,
    tier: 2,
    requestsPerDay: 1000,
    capabilities: ["reasoning"],
  },
  "tencent/hy3-preview": {
    model: "tencent/hy3-preview",
    context: 262_144,
    tier: 2,
    requestsPerDay: 1000,
    expiryDate: new Date("2026-07-21"),
    capabilities: ["reasoning"],
  },
};