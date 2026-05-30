import type { ReviewConfig } from "../types.js";

/** Token budget allocation based on PR size */
export interface BudgetAllocation {
  dimensions: number;
  depth: "full-files" | "diff-with-escalation" | "diff-only";
  thinkingTokens: number;
  maxDiffSize: number;
}

/** Estimated token count for a string (rough estimation: 1 token ≈ 4 chars) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Calculate budget allocation based on PR file count */
export function calculateBudget(fileCount: number, config: ReviewConfig): BudgetAllocation {
  if (config.deep) {
    return {
      dimensions: config.dimensions.length,
      depth: "full-files",
      thinkingTokens: 4000,
      maxDiffSize: 100_000,
    };
  }

  if (fileCount <= 5) {
    return {
      dimensions: config.dimensions.length,
      depth: "full-files",
      thinkingTokens: 4000,
      maxDiffSize: 80_000,
    };
  }

  if (fileCount <= 20) {
    return {
      dimensions: config.dimensions.length,
      depth: "diff-with-escalation",
      thinkingTokens: 4000,
      maxDiffSize: 60_000,
    };
  }

  if (fileCount <= 50) {
    return {
      dimensions: Math.min(config.dimensions.length, 4),
      depth: "diff-only",
      thinkingTokens: 2000,
      maxDiffSize: 40_000,
    };
  }

  // PR > 50 files: reduce dimensions, diff-only
  return {
    dimensions: Math.min(config.dimensions.length, 3),
    depth: "diff-only",
    thinkingTokens: 1600,
    maxDiffSize: 30_000,
  };
}

/** Check if PR is too large and return a warning message */
export function largePRWarning(fileCount: number): string | null {
  if (fileCount > 100) {
    return `Very large PR detected (${fileCount} files). Review may be less thorough. Consider splitting into smaller PRs.`;
  }
  if (fileCount > 50) {
    return `Large PR detected (${fileCount} files). Review scope will be reduced to critical analysis only.`;
  }
  if (fileCount > 30) {
    return `Moderately large PR detected (${fileCount} files). Review will focus on high-risk files.`;
  }
  return null;
}