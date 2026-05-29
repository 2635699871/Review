import { Command } from "commander";
import { buildConfig } from "./core/config.js";
import { runReview } from "./core/orchestrator.js";

const program = new Command();

program
  .name("pr-review")
  .description("AI-powered Pull Request review assistant")
  .version("0.1.0")
  .argument(
    "<pr>",
    'GitHub PR identifier: owner/repo#123 or https://github.com/owner/repo/pull/123'
  )
  .option("-d, --deep", "Enable deep review mode with repo-level context")
  .option(
    "-o, --output <mode>",
    "Output mode: terminal, markdown, github, or all (default: all)",
    "all"
  )
  .option(
    "--dimensions <list>",
    "Review dimensions to run (comma-separated): correctness,security,performance,maintainability",
    "correctness,security,performance,maintainability"
  )
  .option(
    "--max-files <n>",
    "Maximum number of files to review (default: 50)",
    "50"
  )
  .option("--provider <id>", "LLM provider (anthropic, openai, deepseek, gemini, groq, ...)")
  .option("--api-key <key>", "API key for the selected provider")
  .option("--model <name>", "Override the default model for the selected provider")
  .option("--api-base-url <url>", "Override the default API base URL").option("-v, --verbose", "Enable verbose logging")
  .action(async (pr: string, options: Record<string, string | boolean>) => {
    try {
      const config = buildConfig({
        pr,
        deep: options.deep as boolean,
        output: options.output as string,
        dimensions: options.dimensions as string,
        maxFiles: options.maxFiles as string,
        verbose: options.verbose as boolean,
        provider: options.provider as string | undefined,
        apiKey: options.apiKey as string | undefined,
        modelOverride: options.model as string | undefined,
        apiBaseUrl: options.apiBaseUrl as string | undefined,});

      const result = await runReview(config);
      if (!result) {
        process.exit(1);
      }
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  });

export function startCLI(args: string[] = process.argv): void {
  program.parse(args);
}