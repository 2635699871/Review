import type { ProviderType, Finding, Dimension, Severity } from "../types.js";
import { getApiFormat } from "./provider-registry.js";

/** Unified interface for LLM providers */
export interface LLMClient {
  review(
    systemPrompt: string,
    diffContent: string,
    metadata: string,
    dimension: Dimension
  ): Promise<Finding[]>;

  /** Generate a Chinese summary paragraph from aggregated review results */
  summarize(
    systemPrompt: string,
    findingsText: string,
    metadataText: string
  ): Promise<string>;
}

interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  thinkingBudget: number;
  temperature: number;
}

/** Create the appropriate LLM client for the given provider */
export function createLLMClient(config: ProviderConfig): LLMClient {
  const format = getApiFormat(config.type);
  if (format === "anthropic") {
    return createAnthropicClientSync(config);
  }
  return createOpenAICompatibleClientSync(config);
}

// ─── Anthropic client (native SDK) ─────────────────────────

function createAnthropicClientSync(config: ProviderConfig): LLMClient {
  let client: any = null;

  return {
    async review(systemPrompt, diffContent, metadata, dimension) {
      if (!client) {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        client = new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
        });
      }

      const userPrompt = buildUserPrompt(metadata, dimension);
      const startTime = Date.now();

      const response = await client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        system: [{ type: "text", text: systemPrompt }],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: diffContent,
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: userPrompt },
            ],
          },
        ],
        thinking: { type: "enabled", budget_tokens: config.thinkingBudget },
      });

      const elapsed = Date.now() - startTime;
      const usage = (response as any).usage;
      if (usage) {
        console.error(
          `[perf] ${dimension}: ${elapsed}ms, ` +
          `input=${usage.input_tokens}, output=${usage.output_tokens}, ` +
          `cache_read=${usage.cache_read_input_tokens ?? 0}, cache_write=${usage.cache_creation_input_tokens ?? 0}`
        );
      }

      const textBlock = response.content.find((b: any) => b.type === "text");
      const text = (textBlock && "text" in textBlock) ? (textBlock as any).text : "";
      return parseFindings(text, dimension);
    },

    async summarize(systemPrompt, findingsText, metadataText) {
      if (!client) {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        client = new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
        });
      }

      const response = await client.messages.create({
        model: config.model,
        max_tokens: 512,
        temperature: config.temperature,
        system: [{ type: "text", text: systemPrompt }],
        messages: [
          { role: "user", content: [{ type: "text", text: findingsText + "\n\n" + metadataText }] },
        ],
      });

      const textBlock = response.content.find((b: any) => b.type === "text");
      return (textBlock && "text" in textBlock) ? (textBlock as any).text : "";
    },
  };
}

// ─── OpenAI-compatible client (for OpenAI, DeepSeek, custom) ─

function createOpenAICompatibleClientSync(config: ProviderConfig): LLMClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const maxRetries = 3;

  return {
    async review(systemPrompt, diffContent, metadata, dimension) {
      const userPrompt = buildUserPrompt(metadata, dimension);
      const startTime = Date.now();

      let lastError: Error | null = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(baseUrl + "/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              max_tokens: config.maxTokens,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: diffContent + "\n\n" + userPrompt },
              ],
              temperature: config.temperature,
            }),
          });

          if (!response.ok) {
            const errText = await response.text();
            const status = response.status;
            // Retry on server errors and rate limits
            if ((status >= 500 || status === 429) && attempt < maxRetries - 1) {
              await sleep(Math.pow(2, attempt) * 1000);
              continue;
            }
            throw new Error(`OpenAI-compatible API error (${status}): ${errText.slice(0, 300)}`);
          }

          const data: any = await response.json();

          const elapsed = Date.now() - startTime;
          const usage = data.usage;
          if (usage) {
            console.error(
              `[perf] ${dimension} (${config.type}): ${elapsed}ms, ` +
              `input=${usage.prompt_tokens}, output=${usage.completion_tokens}`
            );
          }

          return parseFindings(data.choices?.[0]?.message?.content ?? "", dimension);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < maxRetries - 1 && !(lastError.message.includes("API error (4"))) {
            await sleep(Math.pow(2, attempt) * 1000);
            continue;
          }
          throw lastError;
        }
      }

      throw lastError ?? new Error("Max retries exceeded");
    },

    async summarize(systemPrompt, findingsText, metadataText) {
      const response = await fetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 512,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: findingsText + "\n\n" + metadataText },
          ],
          temperature: config.temperature,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Summarize API error (${response.status}): ${errText.slice(0, 200)}`);
      }

      const data: any = await response.json();
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

// ─── Shared helpers ────────────────────────────────────────

function buildUserPrompt(metadata: string, dimension: Dimension): string {
  return `## PR Metadata

${metadata}

## Instructions

Review the above diff for **${dimension}** issues. For each finding, output JSON:

\`\`\`json
{
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "path/to/file.ts",
      "line": 42,
      "category": "specific-category",
      "issue": "Clear description of the problem",
      "fix": "Specific fix suggestion",
      "code_quote": "The exact line(s) from the diff that triggered this finding",
      "zh_brief": "一行中文简评（30字以内）"
    }
  ]
}
\`\`\`

Rules:
- Only report findings you are highly confident about (>80%)
- Each finding MUST reference a specific line in the diff
- Each finding MUST include \`code_quote\` — copy-paste the exact line(s) from the diff that triggered the finding. This proves the finding is grounded in real code, not speculation.
- Skip style issues that a linter would catch
- Skip generic patterns like "needs error handling" without concrete failure mode
- For zh_brief: write a concise one-line Chinese assessment (under 30 chars). Focus on the core risk or impact.
- If there are no issues, return {"findings": []}
`;
}

function parseFindings(text: string, dimension: Dimension): Finding[] {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]! : text;

    const parsed = JSON.parse(jsonStr);
    const rawFindings: Array<{
      severity: string;
      file: string;
      line?: number;
      category: string;
      issue: string;
      fix: string;
      code_quote?: string;
      zh_brief?: string;
    }> = Array.isArray(parsed.findings) ? parsed.findings : [];

    return rawFindings.map((f) => ({
      severity: normalizeSeverity(f.severity),
      dimension,
      file: f.file,
      line: f.line,
      category: f.category,
      issue: f.issue,
      fix: f.fix,
      confidence: 0.85,
      zhBrief: f.zh_brief,
    }));
  } catch {
    return fallbackParse(text, dimension);
  }
}

function fallbackParse(text: string, dimension: Dimension): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  const pattern =
    /\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s+(.+?):(\d+)?\s*[-–—]\s*(.+)/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      findings.push({
        severity: match[1] as Severity,
        dimension,
        file: match[2]!.trim(),
        line: match[3] ? parseInt(match[3], 10) : undefined,
        category: dimension,
        issue: match[4]!.trim(),
        fix: "See issue description",
        confidence: 0.7,
        zhBrief: undefined,
      });
    }
  }

  return findings;
}

function normalizeSeverity(severity: string): Severity {
  const s = severity.toUpperCase();
  if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(s)) {
    return s as Severity;
  }
  return "MEDIUM";
}

/** Ensure a base URL ends with a valid API path. Only appends /v1 when the URL is a bare hostname. */
function normalizeBaseUrl(url: string): string {
  if (!url) throw new Error("API base URL is required for OpenAI-compatible providers. Use --api-base-url or set the appropriate environment variable.");
  // Already has a versioned API path (/v1, /v1beta/..., /v2, /v3, /v4, /paas/v4, /compatibility/v1, /openai)
  if (/\/v\d/.test(url) || url.endsWith("/openai")) return url;
  // Bare hostname — append /v1
  return url.endsWith("/") ? url + "v1" : url + "/v1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
