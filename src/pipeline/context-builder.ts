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
    const results = await Promise.allSettled(
      highRiskFiles.map((f) =>
        fetchGitHubFile(pr.owner, pr.repo, f.filename, pr.headBranch, gitHubToken)
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
    const conventionTexts: string[] = [];
    for (const file of CONVENTION_FILES) {
      const content = await fetchGitHubFile(
        pr.owner, pr.repo, file, pr.headBranch, gitHubToken
      );
      if (content) {
        conventionTexts.push(`## ${file}\n\n${content}`);
      }
    }
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
