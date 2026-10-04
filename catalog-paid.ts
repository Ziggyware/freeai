import type { Vendor } from "./catalog.ts";
// Paid — last resort, only routed when a key is present.
export const PAID: Vendor[] = [
  { paid: true, vendor: "deepseek", base: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", priority: 40, tags: ["coder", "reasoning"], models: ["deepseek-chat", "deepseek-reasoner"] },
  { paid: true, vendor: "moonshot", base: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY", priority: 41, tags: ["coder", "long"], models: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview"], prefer: "kimi" },
  { paid: true, vendor: "xai", base: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", priority: 42, tags: ["reasoning"], models: ["grok-4-fast-non-reasoning", "grok-4-fast-reasoning"], prefer: "grok.*fast" },
  { paid: true, vendor: "openai", base: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", priority: 43, tags: ["coder", "reasoning", "vision"], models: ["gpt-5-mini", "gpt-4.1-mini"], prefer: "gpt-5-mini|gpt-4.1-mini" },
  // Credit-based (small free grants, then metered): ranked with the paid tier so they are last resorts, not daily drivers.
  { paid: true, vendor: "deepinfra", tps: 60, base: "https://api.deepinfra.com/v1/openai", keyEnv: "DEEPINFRA_API_KEY", priority: 41, tags: ["coder", "reasoning", "long"], models: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "meta-llama/Llama-3.3-70B-Instruct"], prefer: "deepseek|qwen3-coder|llama" },
  { paid: true, vendor: "fireworks", tps: 120, base: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", priority: 42, tags: ["coder", "reasoning", "long"], models: ["accounts/fireworks/models/deepseek-v3p1", "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct", "accounts/fireworks/models/kimi-k2-instruct"], prefer: "deepseek|qwen3-coder|kimi" },
  { paid: true, vendor: "anthropic", base: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", priority: 44, tags: ["coder", "reasoning", "vision"], models: ["claude-sonnet-4-5", "claude-haiku-4-5"], prefer: "haiku|sonnet" },
];
