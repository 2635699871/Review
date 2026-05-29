import type { PRFile, FileStatus } from "../types.js";

/** Patterns for files to exclude from review */
const EXCLUDE_PATTERNS = [
  // Lockfiles
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /Gemfile\.lock$/,
  /go\.sum$/,
  /poetry\.lock$/,
  /pubspec\.lock$/,
  /composer\.lock$/,
  /mix\.lock$/,
  // Generated files
  /\.generated\./,
  /\.gen\.(ts|js|go|rs|py|java|cs)$/,
  /\.g\.dart$/,
  /\.pb\.(go|cc|java)$/,
  /\.g\.ts$/,
  /\.g\.js$/,
  // Vendor / dependencies
  /^vendor\//,
  /^node_modules\//,
  /\.venv\//,
  /__pycache__\//,
  /^third_party\//,
  // Generated chunks
  /chunk-\w+\.(js|css)$/,
  // Minified files
  /\.min\.(js|css)$/,
  // Binary / assets
  /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|tar|gz|mp[34]|webm|webp)$/,
  // Auto-generated changelogs
  /^CHANGELOG\.md$/,
  // IDE config noise (unless substantive)
  /^\.vscode\//,
  /^\.idea\//,
  // Test fixtures with large JSON
  /fixtures?\/.*\.json$/,
  /test-fixtures?\/.*\.json$/,
  // Build outputs
  /^dist\//,
  /^build\//,
  /^target\//,
  /^out\//,
  /\.next\//,
  // Package manager lock change-only files
  /^\.npmrc$/,
];

/** High-risk path indicators */
const HIGH_RISK_PATTERNS = [
  /auth/,
  /login/,
  /password/,
  /secret/,
  /token/,
  /credential/,
  /payment/,
  /billing/,
  /database/,
  /db\//,
  /migration/,
  /security/,
  /encrypt/,
  /decrypt/,
  /permission/,
  /role/,
  /admin/,
  /webhook/,
  /api-key/,
];

/** File categorization result */
export interface FileCategory {
  filtered: PRFile[];
  excluded: PRFile[];
  byType: {
    source: PRFile[];
    test: PRFile[];
    config: PRFile[];
    doc: PRFile[];
  };
  highRisk: PRFile[];
}

/** Test file patterns */
const TEST_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /_test\.(py|go|rs|java)$/,
  /^tests?\//,
  /^spec\//,
  /__tests__\//,
  /^test\//,
  /^test_/,
];

/** Config file patterns */
const CONFIG_PATTERNS = [
  /^tsconfig.*\.json$/,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^jest\.config/,
  /^vitest\.config/,
  /^vite\.config/,
  /^webpack\.config/,
  /^docker-compose/,
  /Dockerfile$/,
  /^renovate/,
  /^dependabot/,
];

/** Doc file patterns */
const DOC_PATTERNS = [
  /\.md$/,
  /\.mdx$/,
  /\.rst$/,
  /\.txt$/,
  /^docs\//,
  /^documentation\//,
  /CONTRIBUTING/,
];

/**
 * Determine if a file should be excluded from review.
 */
export function shouldExclude(file: PRFile): { excluded: boolean; reason?: string } {
  const name = file.filename;

  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(name)) {
      return { excluded: true, reason: pattern.source };
    }
  }

  // Exclude deleted files (no code to review)
  if (file.status === "removed") {
    return { excluded: true, reason: "file removed" };
  }

  // Exclude files with no patch (binary or too large for GitHub to diff)
  if (!file.patch && file.status !== "added") {
    return { excluded: true, reason: "no diff available (binary or large file)" };
  }

  return { excluded: false };
}

/**
 * Detect file type category based on filename.
 */
export function categorizeFile(
  file: PRFile
): "source" | "test" | "config" | "doc" {
  const name = file.filename;

  if (TEST_PATTERNS.some((p) => p.test(name))) return "test";
  if (CONFIG_PATTERNS.some((p) => p.test(name))) return "config";
  if (DOC_PATTERNS.some((p) => p.test(name))) return "doc";
  return "source";
}

/**
 * Check if a file path indicates high risk (auth, payment, DB, etc.).
 */
export function isHighRisk(filename: string): boolean {
  return HIGH_RISK_PATTERNS.some((p) => p.test(filename.toLowerCase()));
}

/**
 * Filter and categorize a list of PR files.
 * Returns the files to review and categorization metadata.
 */
export function filterFiles(
  files: PRFile[],
  options?: { maxFiles?: number }
): FileCategory {
  const result: FileCategory = {
    filtered: [],
    excluded: [],
    byType: { source: [], test: [], config: [], doc: [] },
    highRisk: [],
  };for (const file of files) {
    const { excluded } = shouldExclude(file);
    if (excluded) {
      result.excluded.push(file);
      continue;
    }result.filtered.push(file);
    const type = categorizeFile(file);
    result.byType[type].push(file);

    if (isHighRisk(file.filename)) {
      result.highRisk.push(file);
    }
  }

  // Enforce max files limit
  const max = options?.maxFiles ?? 50;
  if (result.filtered.length > max) {
    const excess = result.filtered.length - max;
    // Drop low-priority files (docs, config, test) first
    const priority = ["doc", "config", "test", "source"] as const;
    let remaining = excess;
    for (const type of priority) {
      if (remaining <= 0) break;
      const list = result.byType[type] as PRFile[];
      while (remaining > 0 && list.length > 0) {
        const removed = list.pop()!;
        result.filtered = result.filtered.filter(
          (f) => f.filename !== removed.filename
        );
        result.excluded.push(removed);
        remaining--;
      }
    }
  }

  return result;
}

/**
 * Get a human-readable summary of the file filter results.
 */
export function summarizeFilter(result: FileCategory): string {
  const parts: string[] = [];
  parts.push(`${result.filtered.length} files reviewed`);
  if (result.excluded.length > 0) {
    parts.push(`${result.excluded.length} files excluded`);
  }
  parts.push(
    `(${result.byType.source.length} src, ${result.byType.test.length} test, ${result.byType.config.length} config)`
  );
  if (result.highRisk.length > 0) {
    parts.push(`[${result.highRisk.length} high-risk]`);
  }
  return parts.join(" | ");
}