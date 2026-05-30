import type { PRMetadata, PRFile, PRCommit, CICheck } from "../types.js";

/**
 * PR Review Fetcher
 *
 * Uses GitHub MCP tools to fetch PR data.
 * In the Claude Code environment, these are called through the MCP system.
 * For standalone use, this module defines the interface that a MCP client or
 * CLI adapter would implement.
 */

export interface GitHubClient {
  getPR(owner: string, repo: string, number: number): Promise<PRData>;
  getFiles(owner: string, repo: string, number: number): Promise<PRFile[]>;
  getComments(owner: string, repo: string, number: number): Promise<Comment[]>;
  getReviews(owner: string, repo: string, number: number): Promise<Review[]>;
  getStatus(owner: string, repo: string, pullNumber: number): Promise<CICheck[]>;
  getCommits(owner: string, repo: string, sha: string): Promise<PRCommit[]>;
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string>;
}

interface PRData {
  title: string;
  body: string | null;
  author: string;
  baseBranch: string;
  headBranch: string;
  state: string;
  draft: boolean;
  mergeable: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface Comment {
  body: string;
  path?: string;
  line?: number;
  author: string;
}

interface Review {
  state: string;
  body: string | null;
  author: string;
}

/** Parse PR identifier into components */
export function parsePRUrl(
  input: string
): { owner: string; repo: string; number: number } {
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

  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
    };
  }

  throw new Error(
    `Invalid PR identifier: "${input}". Expected: owner/repo#123 or https://github.com/owner/repo/pull/123`
  );
}

/**
 * Fetch all PR data in parallel.
 * Returns the complete PRMetadata object used by the review pipeline.
 */
export async function fetchPRData(
  client: GitHubClient,
  prIdentifier: string
): Promise<PRMetadata> {
  const { owner, repo, number } = parsePRUrl(prIdentifier);

  // Phase 1: Parallel fetch of all PR data
  const [prData, files, comments, reviews, status] = await Promise.all([
    client.getPR(owner, repo, number),
    client.getFiles(owner, repo, number),
    client.getComments(owner, repo, number),
    client.getReviews(owner, repo, number),
    client.getStatus(owner, repo, number),
  ]);

  // Fetch commits separately (needs head branch ref)
  const ref = `${owner}/${repo}/${prData.headBranch}`;
  const commits = await client.getCommits(owner, repo, ref);

  return {
    owner,
    repo,
    number,
    title: prData.title,
    body: prData.body,
    author: prData.author,
    baseBranch: prData.baseBranch,
    headBranch: prData.headBranch,
    state: prData.state as "open" | "closed" | "merged",
    draft: prData.draft,
    mergeable: prData.mergeable,
    files,
    additions: prData.additions,
    deletions: prData.deletions,
    changedFiles: prData.changedFiles,
    commits,
    ciStatus: status,
  };
}

/**
 * Build a human-readable summary of the PR.
 */
export function summarizePR(pr: PRMetadata): string {
  const parts = [
    `PR #${pr.number} in ${pr.owner}/${pr.repo}`,
    `Title: ${pr.title}`,
    `Author: ${pr.author}`,
    `Branch: ${pr.headBranch} → ${pr.baseBranch}`,
    `State: ${pr.draft ? "DRAFT" : pr.state.toUpperCase()} | CI: ${ciSummary(pr.ciStatus)}`,
    `Files: ${pr.changedFiles} changed (+${pr.additions} -${pr.deletions})`,
  ];

  if (pr.commits.length > 0) {
    parts.push(`Commits: ${pr.commits.length}`);
  }

  return parts.join("\n");
}

function ciSummary(checks: CICheck[]): string {
  if (checks.length === 0) return "no checks";

  const failed = checks.filter((c) => c.conclusion === "failure");
  const pending = checks.filter(
    (c) => !c.conclusion || c.conclusion === "pending"
  );

  if (failed.length > 0) return `${failed.length} FAILED`;
  if (pending.length > 0) return `${pending.length} pending`;
  return "all pass";
}
