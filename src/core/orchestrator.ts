import type { ReviewConfig, ReviewResult, Finding, ReviewContext, Dimension } from "../types.js";
import { createLLMClient, type LLMClient } from "../models/provider-router.js";
import { filterFiles, summarizeFilter } from "../utils/file-filter.js";
import { languageSummary } from "../utils/language-detect.js";
import { calculateBudget, largePRWarning } from "../utils/token-budget.js";
import {
  buildReviewContext,
  buildEnrichedDiffText,
  buildMetadataText,
} from "../pipeline/context-builder.js";
import { buildReviewerSystemPrompt, getDimensionLabel } from "../models/prompts.js";
import { getProvider, getDefaultModel, getDefaultBaseUrl } from "../models/provider-registry.js";
import { aggregate, determineVerdict } from "../pipeline/aggregator.js";
import { renderTerminal } from "../output/terminal.js";
import { saveReport, submitGitHubReview } from "../output/markdown.js";

/**
 * Main review orchestrator — 5-phase pipeline.
 *
 *   Phase 1: Fetch PR data (metadata, files, commits, CI status)
 *   Phase 2: Filter & categorize files
 *   Phase 3: Review (parallel dimensions via LLM, warmup + burst)
 *   Phase 4: Aggregate (dedup + confidence gate + rank)
 *   Phase 5: Report (terminal + markdown + GitHub)
 */
export async function runReview(config: ReviewConfig): Promise<ReviewResult | null> {
  const notify = config.onProgress ?? (() => {});

  // ─── Phase 1: Fetch ────────────────────────────────────
  const { owner, repo, number } = parseId(config);

  notify({ phase: "fetch", message: `Fetching PR #${number} from ${owner}/${repo}...` });

  let prData;
  try {
    prData = await fetchPRData(owner, repo, number, config.githubToken);
  } catch (error) {
    const msg = `Failed to fetch PR data: ${error instanceof Error ? error.message : String(error)}`;
    notify({ phase: "error", message: msg });
    console.error(msg);
    return null;
  }

  notify({
    phase: "fetch",
    message: `Fetched: ${prData.title}`,
    detail: `${prData.changedFiles} files, +${prData.additions}/-${prData.deletions}, CI: ${ciSummary(prData.ciStatus)}`,
  });

  // ─── Phase 2: Filter & Categorize ─────────────────────
  notify({ phase: "filter", message: "Filtering and categorizing files..." });

  const fileCategory = filterFiles(prData.files, {
    maxFiles: config.maxFiles,});

  notify({
    phase: "filter",
    message: summarizeFilter(fileCategory),
    detail: `Languages: ${languageSummary(prData.files)}`,
  });

  const warning = largePRWarning(prData.changedFiles);
  if (warning) {
    notify({ phase: "filter", message: `Warning: ${warning}`, detail: "" });
  }

  const budget = calculateBudget(prData.changedFiles, config);
  const activeDimensions = config.dimensions.slice(0, budget.dimensions);

  // ─── Phase 3: Build Context + Review ──────────────────
  notify({
    phase: "review",
    message: `Starting ${activeDimensions.length}-dimension review...`,
    detail: activeDimensions.map((d) => getDimensionLabel(d) || d).join(", "),
    percent: 0,
  });

  // Build enriched context (full files for high-risk, conventions for deep mode)
  const token = config.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const ctx = await buildReviewContext({
    pr: prData,
    files: fileCategory.filtered,
    deep: config.deep,
    gitHubToken: token,
  });

  const metadataText = buildMetadataText({
    title: prData.title,
    author: prData.author,
    body: prData.body,
    baseBranch: prData.baseBranch,
    headBranch: prData.headBranch,
    fileCount: prData.changedFiles,
    additions: prData.additions,
    deletions: prData.deletions,
    commits: prData.commits.map((c) => `${c.message.slice(0, 80)}`),
  });

  const diffText = buildEnrichedDiffText(
    fileCategory.filtered,
    ctx.fullFiles,
    budget.maxDiffSize
  );

  // Create LLM client based on provider
  const llmClient = createClient(config, budget);

  // Run dimensions with warmup-first-then-parallel strategy for prompt caching
  const allFindings = await runDimensionsParallel(
    llmClient,
    activeDimensions,
    diffText,
    metadataText,
    ctx.repoConventions,
    notify
  );

  // ─── Phase 4: Aggregate ───────────────────────────────
  notify({ phase: "aggregate", message: "Aggregating and filtering findings...", percent: 60 });

  const { findings: ranked, dropped, downgraded, actionableRate } = aggregate(allFindings);

  notify({
    phase: "aggregate",
    message: `Kept ${ranked.length}, dropped ${dropped}, downgraded ${downgraded}`,
    detail: `Actionable rate: ${Math.round(actionableRate * 100)}%`,
    percent: 80,
  });

  const verdict = determineVerdict(ranked);// ─── Phase 5: Report ──────────────────────────────────
  notify({ phase: "report", message: "Generating report...", percent: 90 });

  const dimSummary = activeDimensions.map((d) => getDimensionLabel(d) || d).join(", ");
  const reviewResult: ReviewResult = {
    pr: prData,
    findings: ranked,
    summary: `This PR changes ${prData.changedFiles} files (+${prData.additions}/-${prData.deletions}), reviewed across ${activeDimensions.length} dimensions: ${dimSummary}.`,verdict,
    actionableRate,
    reviewedAt: new Date().toISOString(),
    dimensionsRun: activeDimensions,
  };

  // Terminal output
  if (config.output === "terminal" || config.output === "all") {
    console.log(renderTerminal(reviewResult));
  }

  // Markdown output
  if (config.output === "markdown" || config.output === "all") {
    saveReport(reviewResult);
  }

  // GitHub output — actually submit the review to the PR
  if (config.output === "github" || config.output === "all") {
    await submitGitHubReviewToPR(reviewResult, token, notify);
  }

  const verdictLabels: Record<string, string> = {
    BLOCK: "BLOCK",
    REQUEST_CHANGES: "REQUEST CHANGES",
    COMMENT: "COMMENT",
  };
  notify({
    phase: "done",
    message: "Review complete",
    detail: verdictLabels[verdict] ?? verdict,
    percent: 100,
  });

  return reviewResult;
}

// ─── Helpers ──────────────────────────────────────────────

function parseId(config: ReviewConfig): { owner: string; repo: string; number: number } {
  const urlMatch = config.prIdentifier.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!.replace(/\.git$/, ""),
      number: parseInt(urlMatch[3]!, 10),
    };
  }

  const shortMatch = config.prIdentifier.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
    };
  }

  throw new Error(`Invalid PR identifier: ${config.prIdentifier}`);
}

/** Create the appropriate LLM client */
function createClient(config: ReviewConfig, budget: { thinkingTokens: number }): LLMClient {
  const providerId = config.provider ?? "anthropic";
  const entry = getProvider(providerId);

  // API key: explicit > env var (per provider) > empty
  const apiKey =
    config.apiKey ??
    (entry ? process.env[entry.envKeyName] : undefined) ??
    "";

  // Base URL: explicit > registry default > empty
  const baseUrl =
    config.apiBaseUrl ??
    getDefaultBaseUrl(providerId) ??
    "";

  // Model: explicit > registry default > empty
  const model =
    config.modelOverride ??
    getDefaultModel(providerId) ??
    "";

  return createLLMClient({
    type: providerId,
    apiKey,
    baseUrl,
    model,
    maxTokens: Math.max(4096, budget.thinkingTokens + 1024),
    thinkingBudget: budget.thinkingTokens,
  });
}

/**
 * Run dimensions with warmup-then-parallel strategy.
 *
 * The first dimension is called alone to populate the prompt cache.
 * The remaining dimensions then fire in parallel, reading from the cache.
 * This gives us ~90% cost reduction on the repeated diff content.
 */
async function runDimensionsParallel(
  client: LLMClient,
  dimensions: Dimension[],
  diffText: string,
  metadataText: string,
  repoConventions: string | undefined,
  notify: (event: any) => void
): Promise<Finding[]> {
  if (dimensions.length === 0) return [];

  // If only one dimension, just run it
  if (dimensions.length === 1) {
    notify({
      phase: "review",
      message: `Reviewing: ${getDimensionLabel(dimensions[0]!) ?? dimensions[0]}...`,
      percent: 10,
    });
    try {
      return await client.review(
        buildReviewerSystemPrompt(dimensions[0]!, repoConventions),
        diffText,
        metadataText,
        dimensions[0]!
      );
    } catch (error) {
      notify({
        phase: "review",
        message: `${dimensions[0]} review failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
  }

  // Warmup: run the first dimension to populate the cache
  const [first, ...rest] = dimensions;
  notify({
    phase: "review",
    message: `Reviewing: ${getDimensionLabel(first!) ?? first} (warmup + caching)...`,
    percent: 5,
  });

  const allFindings: Finding[] = [];

  try {
    const firstFindings = await client.review(
      buildReviewerSystemPrompt(first!, repoConventions),
      diffText,
      metadataText,
      first!
    );
    allFindings.push(...firstFindings);
    notify({
      phase: "review",
      message: `${getDimensionLabel(first!) ?? first}: ${firstFindings.length} finding(s)`,
      percent: 15,
    });
  } catch (error) {
    notify({
      phase: "review",
      message: `${first} review failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Burst: run remaining dimensions in parallel (cache is warm)
  if (rest.length > 0) {
    notify({
      phase: "review",
      message: `Reviewing ${rest.length} more dimensions in parallel...`,
      percent: 20,
    });

    const results = await Promise.allSettled(
      rest.map((dim, i) =>
        client.review(
          buildReviewerSystemPrompt(dim, repoConventions),
          diffText,
          metadataText,
          dim
        ).then((findings) => ({ dim, findings, index: i }))
      )
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { dim, findings } = result.value;
        allFindings.push(...findings);
        notify({
          phase: "review",
          message: `${getDimensionLabel(dim) ?? dim}: ${findings.length} finding(s)`,
          percent: 25 + (result.value.index / rest.length) * 25,
        });
      } else {
        notify({
          phase: "review",
          message: `Dimension failed: ${result.reason}`,
        });
      }
    }
  }

  return allFindings;
}

/** Submit the review as a comment on the GitHub PR */
async function submitGitHubReviewToPR(
  result: ReviewResult,
  token: string,
  notify: (event: any) => void
): Promise<void> {
  if (!token) {
    notify({
      phase: "report",
      message: "Skipping GitHub submission: no GITHUB_TOKEN provided",
    });
    return;
  }

  const { ok, status, message } = await submitGitHubReview(result, token);
  if (ok) {
    notify({
      phase: "report",
      message: `Review submitted to PR #${result.pr.number}`,
    });
  } else {
    notify({
      phase: "report",
      message: `Failed to submit GitHub review: ${status} ${message.slice(0, 200)}`,
    });
  }
}

/** Fetch PR data directly from GitHub REST API */
async function fetchPRData(
  owner: string,
  repo: string,
  number: number,
  overrideToken?: string
) {
  const token = overrideToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "pr-review-assistant",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

  const [prResp, filesResp, commitsResp] = await Promise.all([
    fetch(`${baseUrl}/pulls/${number}`, { headers }),
    fetch(`${baseUrl}/pulls/${number}/files?per_page=100`, { headers }),
    fetch(`${baseUrl}/pulls/${number}/commits?per_page=100`, { headers }),
  ]);

  if (!prResp.ok) {
    throw new Error(`Failed to fetch PR: ${prResp.status} ${prResp.statusText}`);
  }

  const prJson: any = await prResp.json();
  const filesJson: any[] = filesResp.ok ? await filesResp.json() : [];
  const commitsJson: any[] = commitsResp.ok ? await commitsResp.json() : [];

  // Fetch CI checks for the head commit
  let ciStatus: Array<{ name: string; status: string; conclusion: string | null }> = [];
  try {
    const headSha = prJson.head?.sha;
    if (headSha && token) {
      const checksResp = await fetch(
        `${baseUrl}/commits/${headSha}/check-runs?per_page=50`,
        {
          headers: { ...headers, Accept: "application/vnd.github.antiope-preview+json" },
        }
      );
      if (checksResp.ok) {
        const checksJson: any = await checksResp.json();
        ciStatus = (checksJson.check_runs ?? []).map((c: any) => ({
          name: c.name ?? "",
          status: c.status ?? "completed",
          conclusion: c.conclusion ?? null,
        }));
      }
    }
  } catch {
    // CI status is non-critical — if it fails, continue without it
  }

  return {
    owner,
    repo,
    number,
    title: prJson.title ?? "Unknown",
    body: prJson.body ?? null,
    author: prJson.user?.login ?? "unknown",
    baseBranch: prJson.base?.ref ?? "main",
    headBranch: prJson.head?.ref ?? "unknown",
    state: (prJson.state === "closed" && prJson.merged ? "merged" : prJson.state) ?? "open",
    draft: prJson.draft ?? false,
    mergeable: String(prJson.mergeable ?? "unknown"),
    files: filesJson.map((f: any) => ({
      filename: f.filename,
      status: f.status ?? "changed",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changes: f.changes ?? 0,
      patch: f.patch,
      blob_url: f.blob_url,
      raw_url: f.raw_url,
    })),
    additions: prJson.additions ?? 0,
    deletions: prJson.deletions ?? 0,
    changedFiles: prJson.changed_files ?? 0,
    commits: commitsJson.map((c: any) => ({
      sha: c.sha ?? "",
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? "unknown",
      date: c.commit?.author?.date ?? "",
    })),
    ciStatus,
  };
}

function ciSummary(checks: Array<{ conclusion: string | null }>): string {
  if (checks.length === 0) return "no checks";
  const failed = checks.filter((c) => c.conclusion === "failure").length;
  if (failed > 0) return `${failed} FAILED`;
  return "all pass";
}