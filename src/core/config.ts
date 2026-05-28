import type { ReviewConfig, Dimension } from "../types.js";

const ALL_DIMENSIONS: Dimension[] = [
  "correctness",
  "security",
  "performance",
  "maintainability",
];

/** Parse PR identifier from user input (URL or shorthand) */
export function parsePRIdentifier(
  input: string
): { owner: string; repo: string; number: number } | null {
  // URL format: https://github.com/owner/repo/pull/42
  const urlMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!.replace(/\.git$/, ""),
      number: parseInt(urlMatch[3]!, 10),
    };
  }

  // Shorthand format: owner/repo#42
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
    };
  }

  return null;
}

/** Build the final ReviewConfig from CLI input */
export function buildConfig(options: {
  pr: string;
  deep?: boolean;
  output?: string;
  dimensions?: string;
  maxFiles?: string;
  verbose?: boolean;
  provider?: string;
  apiKey?: string;
  modelOverride?: string;
  apiBaseUrl?: string;}): ReviewConfig {
  const prIdentifier = parsePRIdentifier(options.pr);
  if (!prIdentifier) {
    throw new Error(
      `Invalid PR identifier: "${options.pr}". Expected format: owner/repo#123 or https://github.com/owner/repo/pull/123`
    );
  }

  return {
    prIdentifier: options.pr,
    deep: options.deep ?? false,
    output: (options.output as ReviewConfig["output"]) ?? "all",
    dimensions: options.dimensions
      ? (options.dimensions.split(",").map((d) => d.trim()) as Dimension[])
      : [...ALL_DIMENSIONS],
    maxFiles: options.maxFiles ? parseInt(options.maxFiles, 10) : 50,verbose: options.verbose ?? false,
    provider: options.provider as ReviewConfig["provider"],
    apiKey: options.apiKey,
    modelOverride: options.modelOverride,
    apiBaseUrl: options.apiBaseUrl,
  };
}
