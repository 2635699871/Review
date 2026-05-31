import type { PRFile, PRMetadata, ReviewContext } from "../types.js";
import { isHighRisk } from "../utils/file-filter.js";

/**
 * Context Builder — progressive context acquisition.
 *
 * Level 1: Diff hunks only — sufficient for ~70% of findings
 * Level 2: Full file content for high-risk files (escalation)
 * Level 3: Repo conventions (CLAUDE.md, etc.) with --deep
 */

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
}

/** Fetch file content from GitHub API */
async function fetchGitHubFile(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "pr-review-assistant",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    const data: GitHubContentResponse = await resp.json();
    if (!data.content || data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Convention files to fetch in deep mode */
const CONVENTION_FILES = [
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/DEVELOPMENT.md",
  "docs/STYLE_GUIDE.md",
];

/** Config files to auto-discover in deep mode (probed in parallel) */
const DISCOVERABLE_CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.app.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  "prettier.config.js",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  ".env.example",
];

/** Build full review context with progressive levels */
export async function buildReviewContext(params: {
  pr: PRMetadata;
  files: PRFile[];
  deep: boolean;
  gitHubToken: string;
}): Promise<ReviewContext> {
  const { pr, files, deep, gitHubToken } = params;
  const highRiskFiles = files.filter((f) => isHighRisk(f.filename));
  const fullFiles = new Map<string, string>();
  const existingComments: string[] = [];

  // Level 2: Fetch full file content for high-risk files
  if (highRiskFiles.length > 0 && gitHubToken) {
    // Use headSha as fallback ref for forked PRs where the branch doesn't exist in the base repo
    const ref = pr.headBranch;
    const fallbackRef = pr.headSha;
    const results = await Promise.allSettled(
      highRiskFiles.map((f) =>
        fetchGitHubFile(pr.owner, pr.repo, f.filename, ref, gitHubToken).then(
          (content) => content ?? (fallbackRef ? fetchGitHubFile(pr.owner, pr.repo, f.filename, fallbackRef, gitHubToken) : null)
        )
      )
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) {
        fullFiles.set(highRiskFiles[i]!.filename, r.value);
      }
    });
  }

  // Level 3: Fetch repo conventions in deep mode
  let repoConventions: string | undefined;
  if (deep && gitHubToken) {
    const ref = pr.headBranch;
    const fallbackRef = pr.headSha;
    const conventionTexts: string[] = [];
    for (const file of CONVENTION_FILES) {
      let content = await fetchGitHubFile(
        pr.owner, pr.repo, file, ref, gitHubToken
      );
      if (!content && fallbackRef) {
        content = await fetchGitHubFile(pr.owner, pr.repo, file, fallbackRef, gitHubToken);
      }
      if (content) {
        conventionTexts.push(`## ${file}\n\n${content}`);
      }
    }
    // Phase B: Auto-discover project config files
    const discoveredTexts: string[] = [];
    const probeResults = await Promise.allSettled(
      DISCOVERABLE_CONFIG_FILES.map(async (file) => {
        let content = await fetchGitHubFile(pr.owner, pr.repo, file, ref, gitHubToken);
        if (!content && fallbackRef) {
          content = await fetchGitHubFile(pr.owner, pr.repo, file, fallbackRef, gitHubToken);
        }
        return { file, content };
      })
    );
    for (const r of probeResults) {
      if (r.status === "fulfilled" && r.value.content) {
        discoveredTexts.push(`## ${r.value.file}\n\n${r.value.content.slice(0, 6000)}`);
        if (discoveredTexts.length >= 12) break;
      }
    }
    conventionTexts.push(...discoveredTexts);

    if (conventionTexts.length > 0) {
      repoConventions = conventionTexts.join("\n\n---\n\n");
    }
  }

  return {
    pr,
    filteredFiles: files,
    highRiskFiles,
    fullFiles,
    repoConventions,
    existingComments,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

/**
 * Build diff text from PR files for the review prompt.
 * Sorts by change count (desc) so the most important files come first,
 * and truncates from the bottom if the diff exceeds the budget.
 */
export function buildDiffText(files: PRFile[], maxBytes = 80_000): string {
  // Sort by total changes descending (most changed = most important)
  const sorted = [...files].sort((a, b) => b.changes - a.changes);
  const parts: string[] = [];

  for (const file of sorted) {
    const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})\n`;
    if (file.patch) {
      parts.push(header + "```diff\n" + file.patch + "\n```\n");
    } else if (file.status === "added") {
      parts.push(header + `[New file, no diff available — ${file.additions} lines]\n`);
    }
  }

  let text = parts.join("\n");
  if (text.length > maxBytes) {
    const truncatedFiles = new Set<string>();
    let bytesSoFar = 0;

    for (let i = 0; i < parts.length; i++) {
      bytesSoFar += parts[i]!.length;
      if (bytesSoFar > maxBytes) {
        text = parts.slice(0, i).join("\n");
        for (let j = i; j < sorted.length; j++) {
          truncatedFiles.add(sorted[j]!.filename);
        }
        break;
      }
    }

    const truncatedList = [...truncatedFiles].slice(0, 10).join(", ");
    text += `\n\n[Diff truncated at ${maxBytes} bytes. ${truncatedFiles.size} file(s) omitted: ${truncatedList}... Total ${files.length} files.]`;
  }

  return text;
}

/** Build review diff enriched with full-file content for high-risk files */
export function buildEnrichedDiffText(
  files: PRFile[],
  fullFiles: Map<string, string>,
  maxBytes = 80_000
): string {
  let text = buildDiffText(files, maxBytes);

  // Append full file content for high-risk files at the end
  if (fullFiles.size > 0) {
    const fullSections: string[] = [];
    for (const [filename, content] of fullFiles) {
      fullSections.push(`\n### Full file: ${filename}\n\`\`\`\n${content.slice(0, 12_000)}\n\`\`\``);
    }
    text += fullSections.join("\n");
  }

  return text;
}

/**
 * Build cross-file caller context for the cross-file dimension.
 * Extracts changed function/class names from diffs and finds call sites in other files.
 * Returns null if no changed functions have external callers.
 */
export function buildCrossFileContext(
  files: PRFile[],
  fullFiles: Map<string, string>
): string | null {
  // 1. Extract changed function/class names from diff patches
  const changedSymbols: Array<{ name: string; file: string; kind: string }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.patch) continue;
    // Collect contiguous + lines to match multi-line signatures
    const lines = file.patch.split("\n");
    let block: string[] = [];
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        block.push(line.slice(1)); // strip the + prefix
      } else if (line.startsWith(" ") || line.startsWith("-")) {
        // Flush the + block
        if (block.length > 0) {
          extractSymbols(block.join("\n"), file.filename, changedSymbols, seen);
          block = [];
        }
      }
      // @@ and other lines: ignore, continue accumulating
    }
    if (block.length > 0) {
      extractSymbols(block.join("\n"), file.filename, changedSymbols, seen);
    }
  }

  if (changedSymbols.length === 0) return null;

  // 2. Find call sites in OTHER files
  const callerSnippets: string[] = [];

  for (const sym of changedSymbols) {
    const wordBoundary = new RegExp("\\b" + escapeRegex(sym.name) + "\\b");

    for (const file of files) {
      if (file.filename === sym.file) continue; // skip same file

      // Use full file content if available, otherwise fall back to patch
      const content = fullFiles.get(file.filename) ?? file.patch ?? "";
      const contentLines = content.split("\n");

      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i]!;
        if (wordBoundary.test(line)) {
          // Extract 2 lines before and 2 lines after
          const start = Math.max(0, i - 2);
          const end = Math.min(contentLines.length, i + 3);
          const snippet = contentLines
            .slice(start, end)
            .map((l, idx) => `${String(start + idx + 1).padStart(4, " ")}: ${l}`)
            .join("\n");

          callerSnippets.push(
            `### \`${sym.name}()\` called at ${file.filename}:${i + 1}\n\`\`\`\n${snippet}\n\`\`\`\n`
          );
          break; // one call site per file per symbol is enough
        }
      }
    }
  }

  if (callerSnippets.length === 0) return null;

  return `The following functions/classes were changed in this PR and have callers elsewhere:\n\n${callerSnippets.join("\n")}`;
}

/** Extract function/class/method names from a code block */
function extractSymbols(
  code: string,
  filename: string,
  out: Array<{ name: string; file: string; kind: string }>,
  seen: Set<string>
): void {
  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /\bfunction\s+(\w+)/g, kind: "function" },
    { regex: /\bclass\s+(\w+)/g, kind: "class" },
    { regex: /\bconst\s+(\w+)\s*=\s*(?:async\s*)?\(/g, kind: "arrow" },
    { regex: /\b(?:public|private|protected|static)\s+(?:async\s+)?(\w+)\s*\(/g, kind: "method" },
    { regex: /\bexport\s+(?:const|function|class)\s+(\w+)/g, kind: "export" },
  ];

  for (const { regex, kind } of patterns) {
    for (const m of code.matchAll(regex)) {
      const name = m[1]!;
      const key = `${filename}:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, file: filename, kind });
      }
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a human-readable metadata summary for the prompt.
 */
export function buildMetadataText(params: {
  title: string;
  author: string;
  body: string | null;
  baseBranch: string;
  headBranch: string;
  fileCount: number;
  additions: number;
  deletions: number;
  commits: string[];
}): string {
  const parts = [
    `PR Title: ${params.title}`,
    `Author: ${params.author}`,
    `Branch: ${params.headBranch} → ${params.baseBranch}`,
    `Files: ${params.fileCount} changed (+${params.additions} -${params.deletions})`,
  ];

  if (params.body) {
    parts.push(`\nPR Description:\n${params.body}`);
  }

  if (params.commits.length > 0) {
    parts.push(
      `\nCommits:\n${params.commits.map((c) => `  - ${c}`).join("\n")}`
    );
  }

  return parts.join("\n");
}
