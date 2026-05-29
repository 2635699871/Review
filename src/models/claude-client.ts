import Anthropic from "@anthropic-ai/sdk";
import type { Finding, Dimension, Severity } from "../types.js";

/** Claude client configuration */
export interface ClaudeConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  thinkingBudget?: number;
  maxRetries?: number;
}

/** Default configuration */
const DEFAULT_CONFIG: Required<ClaudeConfig> = {
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
  model: "claude-sonnet-4-20250514",
  maxTokens: 4096,
  thinkingBudget: 4000,
  maxRetries: 3,
};

/** Structured finding expected from Claude's response */
interface RawFinding {
  severity: string;
  file: string;
  line?: number;
  category: string;
  issue: string;
  fix: string;
}

/** Performance record */
interface ReviewPerf {
  dimension: Dimension;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Claude API client wrapper with prompt caching and retry support.
 *
 * Uses Anthropic's prompt caching API correctly:
 * - cache_control is set on the user message's content block containing the diff
 * - The first call writes the cache; subsequent calls read it (90% cost reduction)
 * - Parallel calls after a "warmup" call share the cache
 */
export class ClaudeClient {
  private client: Anthropic;
  private config: Required<ClaudeConfig>;
  private perfRecords: ReviewPerf[] = [];
  private cacheWarmed = false;

  constructor(config?: ClaudeConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
  }

  /** Get accumulated performance records */
  getPerfRecords(): ReviewPerf[] {
    return [...this.perfRecords];
  }

  /**
   * Send a review request to Claude with prompt caching on the diff content.
   * On the first call, the diff is written to the ephemeral cache.
   * Subsequent calls read from the cache, reducing input cost by ~90%.
   */
  async review(
    systemPrompt: string,
    diffContent: string,
    metadata: string,
    dimension: Dimension
  ): Promise<Finding[]> {
    const userPrompt = buildUserPrompt(metadata, diffContent, dimension);
    const startTime = Date.now();

    const result = await this.callWithRetry(diffContent, systemPrompt, userPrompt);

    const elapsed = Date.now() - startTime;

    // Parse response and extract usage
    const text = result.text;
    const findings = this.parseFindings(text, dimension);

    const usage = result.usage;
    const perf: ReviewPerf = {
      dimension,
      latencyMs: elapsed,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    };
    this.perfRecords.push(perf);

    console.error(
      `[perf] ${dimension}: ${elapsed}ms | ` +
      `in=${perf.inputTokens} out=${perf.outputTokens} | ` +
      `cache: read=${perf.cacheReadTokens} write=${perf.cacheWriteTokens}`
    );

    return findings;
  }

  private async callWithRetry(
    cachedDiff: string,
    systemPrompt: string,
    userPrompt: string
  ): Promise<{ text: string; usage?: any }> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: [{ type: "text", text: systemPrompt }],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: cachedDiff,
                  // Ephemeral cache: first call writes, subsequent calls read
                  cache_control: { type: "ephemeral" },
                },
                { type: "text", text: userPrompt },
              ],
            },
          ],
          thinking: {
            type: "enabled",
            budget_tokens: this.config.thinkingBudget,
          },
        });

        // Extract text from the response
        const textBlock = response.content.find((b) => b.type === "text");
        const text = textBlock && "text" in textBlock ? textBlock.text : "";
        return { text, usage: (response as any).usage };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.config.maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s
          await sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw lastError ?? new Error("Max retries exceeded");
  }

  /**
   * Parse Claude's structured JSON response into Finding objects.
   */
  private parseFindings(text: string, dimension: Dimension): Finding[] {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1]! : text;

      const parsed = JSON.parse(jsonStr);
      const rawFindings: RawFinding[] = parsed.findings ?? [];

      return rawFindings.map((f) => ({
        severity: normalizeSeverity(f.severity),
        dimension,
        file: f.file,
        line: f.line,
        category: f.category,
        issue: f.issue,
        fix: f.fix,
        confidence: 0.8,
      }));
    } catch {
      return this.fallbackParse(text, dimension);
    }
  }

  /**
   * Fallback parser for non-JSON responses — extract findings from structured text.
   */
  private fallbackParse(text: string, dimension: Dimension): Finding[] {
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
        });
      }
    }

    return findings;
  }
}

function buildUserPrompt(
  metadata: string,
  diff: string,
  dimension: Dimension
): string {
  return `## PR Metadata

${metadata}

## Code Diff to Review

${diff}

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
      "fix": "Specific fix suggestion"
    }
  ]
}
\`\`\`

Rules:
- Only report findings you are highly confident about (>80%)
- Each finding MUST reference a specific line in the diff
- Skip style issues that a linter would catch
- Skip generic patterns like "needs error handling" without concrete failure mode
- If there are no issues, return {"findings": []}
`;
}

function normalizeSeverity(severity: string): Severity {
  const s = severity.toUpperCase();
  if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(s)) {
    return s as Severity;
  }
  return "MEDIUM";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}