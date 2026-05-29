export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  envKeyName: string;
  apiFormat: "anthropic" | "openai-compatible";
  apiKeyPrefix: string;
  website: string;
}

export const PROVIDER_REGISTRY: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-20250514",
    envKeyName: "ANTHROPIC_API_KEY",
    apiFormat: "anthropic",
    apiKeyPrefix: "sk-ant-",
    website: "https://console.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    envKeyName: "OPENAI_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "sk-",
    website: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    envKeyName: "DEEPSEEK_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "sk-",
    website: "https://platform.deepseek.com",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    envKeyName: "GEMINI_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    envKeyName: "GROQ_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "gsk_",
    website: "https://console.groq.com/keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    envKeyName: "MISTRAL_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://console.mistral.ai/api-keys",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.ai/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    envKeyName: "TOGETHER_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "xai",
    label: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.3",
    envKeyName: "XAI_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://console.x.ai",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    envKeyName: "MOONSHOT_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://platform.moonshot.ai",
  },
  {
    id: "qwen",
    label: "Qwen (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    envKeyName: "DASHSCOPE_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://bailian.console.aliyun.com",
  },
  {
    id: "zhipu",
    label: "ZhipuAI (GLM)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.7",
    envKeyName: "ZHIPUAI_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://open.bigmodel.cn",
  },
  {
    id: "baichuan",
    label: "Baichuan (百川)",
    baseUrl: "https://api.baichuan-ai.com/v1",
    defaultModel: "Baichuan4-Turbo",
    envKeyName: "BAICHUAN_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://platform.baichuan-ai.com",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    envKeyName: "MINIMAX_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://platform.minimax.io",
  },
  {
    id: "doubao",
    label: "Doubao (豆包)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-2-0-pro-260215",
    envKeyName: "ARK_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://console.volcengine.com/ark",
  },
  {
    id: "cohere",
    label: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    defaultModel: "command-a-plus-05-2026",
    envKeyName: "CO_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "https://dashboard.cohere.com/api-keys",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar-pro",
    envKeyName: "PERPLEXITY_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "pplx-",
    website: "https://www.perplexity.ai/settings/api",
  },
  {
    id: "custom",
    label: "Custom (OpenAI Compatible)",
    baseUrl: "",
    defaultModel: "",
    envKeyName: "CUSTOM_API_KEY",
    apiFormat: "openai-compatible",
    apiKeyPrefix: "",
    website: "",
  },
];

const providerMap = new Map<string, ProviderPreset>();
for (const p of PROVIDER_REGISTRY) {
  providerMap.set(p.id, p);
}

export type ProviderType = (typeof PROVIDER_REGISTRY)[number]["id"];

export function getProvider(id: string): ProviderPreset | undefined {
  return providerMap.get(id);
}

export function getApiFormat(id: string): "anthropic" | "openai-compatible" {
  return providerMap.get(id)?.apiFormat ?? "openai-compatible";
}

export function getDefaultModel(id: string): string {
  return providerMap.get(id)?.defaultModel ?? "";
}

export function getDefaultBaseUrl(id: string): string {
  return providerMap.get(id)?.baseUrl ?? "";
}
