import type { ReviewConfig, ReviewResult, Finding, ReviewContext, Dimension } from "../types.js";
import { createLLMClient, type LLMClient } from "../models/provider-router.js";
import { filterFiles, summarizeFilter } from "../utils/file-filter.js";
import { calculateBudget, largePRWarning } from "../utils/token-budget.js";
import {
  buildReviewContext,
  buildEnrichedDiffText,
  buildMetadataText,
  buildCrossFileContext,
} from "../pipeline/context-builder.js";
import { buildReviewerSystemPrompt, buildSummarySystemPrompt, buildVerifySystemPrompt, buildVerifyFindingInfo, getDimensionLabel } from "../models/prompts.js";
import { getProvider, getDefaultModel, getDefaultBaseUrl } from "../models/provider-registry.js";
import { aggregate, determineVerdict, SEVERITY_ORDER } from "../pipeline/aggregator.js";
import { verifyFindings } from "../pipeline/verifier.js";
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
  const startTime = Date.now();
  const notifyRaw = config.onProgress ?? (() => {});
  const notify = (event: Parameters<typeof notifyRaw>[0]): void => {
    if (event.percent != null && event.percent > 0 && event.percent < 100) {
      const elapsed = (Date.now() - startTime) / 1000;
      const total = (elapsed / event.percent) * 100;
      event.etaSeconds = Math.round(total - elapsed);
    }
    notifyRaw(event);
  };

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
    maxFiles: config.maxFiles,
    excludePatterns: config.exclude,
  });

  notify({
    phase: "filter",
    message: summarizeFilter(fileCategory),
    detail: `${prData.changedFiles} files changed`,
  });

  const warning = largePRWarning(prData.changedFiles);
  if (warning) {
    notify({ phase: "filter", message: `Warning: ${warning}`, detail: "" });
  }

  const budget = calculateBudget(prData.changedFiles, config);

  // ─── Phase 3: Build Context + Review ──────────────────

  // Build enriched context (full files for high-risk, conventions for deep mode)
  const token = config.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const ctx = await buildReviewContext({
    pr: prData,
    files: fileCategory.filtered,
    deep: config.deep,
    gitHubToken: token,
  });

  // Conditional dimension filtering
  let applicableDimensions = [...config.dimensions];

  if (ctx.totalDeletions === 0 && applicableDimensions.includes("removed-behavior")) {
    applicableDimensions = applicableDimensions.filter(d => d !== "removed-behavior");
    notify({ phase: "filter", message: "Skipping removed-behavior: PR has no deletions" });
  }

  let crossFileContext: string | null = null;
  if (applicableDimensions.includes("cross-file")) {
    crossFileContext = buildCrossFileContext(ctx.filteredFiles, ctx.fullFiles);
    if (!crossFileContext) {
      applicableDimensions = applicableDimensions.filter(d => d !== "cross-file");
      notify({ phase: "filter", message: "Skipping cross-file: no external callers found for changed functions" });
    }
  }

  const activeDimensions = applicableDimensions.slice(0, budget.dimensions);

  notify({
    phase: "review",
    message: `Starting ${activeDimensions.length}-dimension review...`,
    detail: activeDimensions.map((d) => getDimensionLabel(d) || d).join(", "),
    percent: 0,
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

  // Build per-dimension extra context (cross-file dimension gets caller snippets)
  const dimensionExtraContext = new Map<string, string>();
  if (crossFileContext && activeDimensions.includes("cross-file")) {
    dimensionExtraContext.set("cross-file", crossFileContext);
  }

  // Create separate LLM clients for review (finder) and verify (judge) phases.
  // This lets users pair a high-recall cheap model (e.g., DeepSeek Flash) for
  // finding bugs with a precise model (e.g., DeepSeek Pro) for verifying them.
  const reviewClient = createClient(config, budget, config.reviewModel ?? config.modelOverride);
  const verifyClient = config.verifyModel
    ? createClient(config, budget, config.verifyModel)
    : reviewClient;

  // Run dimensions with warmup-first-then-parallel strategy for prompt caching
  const rawFindings = await runDimensionsParallel(
    reviewClient,
    activeDimensions,
    diffText,
    metadataText,
    ctx.repoConventions,
    notify,
    dimensionExtraContext,
  );
  console.error(`[orch] rawFindings from review: ${rawFindings.length}`);

  // Verify code_quote grounding — adjust confidence dynamically
  const verifiedFindings = verifyFindings(rawFindings, diffText, fileCategory.filtered);
  console.error(`[orch] after verifyFindings: ${verifiedFindings.length}`);

  // ─── Phase 4: Aggregate ───────────────────────────────
  notify({ phase: "aggregate", message: "Aggregating and filtering findings...", percent: 60 });

  const { findings: ranked, dropped, downgraded, actionableRate } = aggregate(verifiedFindings);
  console.error(`[orch] after aggregate: kept=${ranked.length} dropped=${dropped} downgraded=${downgraded}`);

  notify({
    phase: "aggregate",
    message: `Kept ${ranked.length}, dropped ${dropped}, downgraded ${downgraded}`,
    detail: `Actionable rate: ${Math.round(actionableRate * 100)}%`,
    percent: 80,
  });

  const verdict = determineVerdict(ranked);

  // ─── Phase 4.5: LLM Verification ────────────────────────
  const verifiedRanked =
    ranked.length > 0
      ? await verifyFindingsLLM(verifyClient, diffText, ranked, notify)
      : ranked;

  console.error(`[orch] after LLM verify: ${verifiedRanked.length} (was ${ranked.length})`);

  const finalVerdict = determineVerdict(verifiedRanked);

  // ─── Phase 4.6: Chinese Summary ─────────────────────────
  notify({ phase: "aggregate", message: "Generating Chinese summary...", percent: 85 });

  let zhSummary: string | undefined;
  try {
    const summaryPrompt = buildSummarySystemPrompt(finalVerdict, verifiedRanked.length);
    const findingsSummary = buildFindingsSummary(verifiedRanked);
    zhSummary = await verifyClient.summarize(summaryPrompt, findingsSummary, metadataText);
  } catch (error) {
    notify({
      phase: "aggregate",
      message: `Chinese summary skipped: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // ─── Phase 5: Report ──────────────────────────────────
  notify({ phase: "report", message: "Generating report...", percent: 90 });

  const dimSummary = activeDimensions.map((d) => getDimensionLabel(d) || d).join(", ");
  const reviewResult: ReviewResult = {
    pr: prData,
    findings: verifiedRanked,
    summary: `This PR changes ${prData.changedFiles} files (+${prData.additions}/-${prData.deletions}), reviewed across ${activeDimensions.length} dimensions: ${dimSummary}.`,
    zhSummary,
    verdict: finalVerdict,
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

/** Create an LLM client for a specific pipeline phase.
 *  @param modelOverride — phase-specific model override (reviewModel or verifyModel)
 */
function createClient(
  config: ReviewConfig,
  budget: { thinkingTokens: number },
  modelOverride?: string,
): LLMClient {
  const providerId = config.provider ?? "anthropic";
  const entry = getProvider(providerId);

  // API key: explicit > provider env var > empty
  const apiKey =
    config.apiKey ??
    (entry ? process.env[entry.envKeyName] : undefined) ??
    "";

  // Base URL: explicit > registry default > empty
  const baseUrl =
    config.apiBaseUrl ??
    getDefaultBaseUrl(providerId) ??
    "";

  // Model: phase-specific > explicit modelOverride > registry default > empty
  const model =
    modelOverride ??
    config.modelOverride ??
    getDefaultModel(providerId) ??
    "";

  return createLLMClient({
    type: providerId,
    apiKey,
    baseUrl,
    model,
    maxTokens: Math.max(4096, budget.thinkingTokens + 1536),
    thinkingBudget: budget.thinkingTokens,
    temperature: 0,
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
  notify: (event: any) => void,
  dimensionExtraContext?: Map<string, string>,
): Promise<Finding[]> {
  if (dimensions.length === 0) return [];

  // Build dimension-specific metadata (appends extra context for cross-file etc.)
  function dimMetadata(dim: string): string {
    const extra = dimensionExtraContext?.get(dim);
    if (!extra) return metadataText;
    return `${metadataText}

## Cross-File Context

${extra}`;
  }

  // Helper to build dimension status map
  function buildDimStatus(state: Record<string, string>): Record<string, string> {
    return Object.fromEntries(dimensions.map((d) => [d, state[d] ?? "pending"]));
  }

  // If only one dimension, just run it
  if (dimensions.length === 1) {
    notify({
      phase: "review",
      message: `Reviewing: ${getDimensionLabel(dimensions[0]!) ?? dimensions[0]}...`,
      percent: 10,
      dimensionStatus: buildDimStatus({ [dimensions[0]!]: "running" }),
    });
    try {
      return await client.review(
        buildReviewerSystemPrompt(dimensions[0]!, repoConventions),
        diffText,
        dimMetadata(dimensions[0]!),
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
    dimensionStatus: buildDimStatus({ [first!]: "running" }),
  });

  const allFindings: Finding[] = [];

  try {
    const firstFindings = await client.review(
      buildReviewerSystemPrompt(first!, repoConventions),
      diffText,
      dimMetadata(first!),
      first!
    );
    allFindings.push(...firstFindings);
    const restRunning: Record<string, string> = { [first!]: "done" };
    for (const d of rest) restRunning[d] = "running";
    notify({
      phase: "review",
      message: `${getDimensionLabel(first!) ?? first}: ${firstFindings.length} finding(s)`,
      percent: 15,
      dimensionStatus: buildDimStatus(restRunning),
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
          dimMetadata(dim),
          dim
        ).then((findings) => ({ dim, findings, index: i }))
      )
    );

    const doneDims: Record<string, string> = { [first!]: "done" };
    for (const d of rest) doneDims[d] = "running";
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { dim, findings } = result.value;
        allFindings.push(...findings);
        doneDims[dim] = "done";
        notify({
          phase: "review",
          message: `${getDimensionLabel(dim) ?? dim}: ${findings.length} finding(s)`,
          percent: 25 + (result.value.index / rest.length) * 25,
          dimensionStatus: buildDimStatus(doneDims),
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

  // Paginated fetch helper — follows Link headers to collect all pages
  async function fetchAllPages(url: string): Promise<any[]> {
    const all: any[] = [];
    let nextUrl: string | null = url;
    while (nextUrl) {
      const resp: Response = await fetch(nextUrl, { headers });
      if (!resp.ok) break;
      all.push(...(await resp.json()) as any[]);
      nextUrl = null;
      const link: string | null = resp.headers.get("link");
      if (link) {
        const m: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
        if (m) nextUrl = m[1]!;
      }
    }
    return all;
  }

  const [prResp, filesJson, commitsJson] = await Promise.all([
    fetch(`${baseUrl}/pulls/${number}`, { headers }),
    fetchAllPages(`${baseUrl}/pulls/${number}/files?per_page=100`),
    fetchAllPages(`${baseUrl}/pulls/${number}/commits?per_page=100`),
  ]);

  if (!prResp.ok) {
    throw new Error(`Failed to fetch PR: ${prResp.status} ${prResp.statusText}`);
  }

  const prJson: any = await prResp.json();

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
    headSha: prJson.head?.sha,
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

/** Run independent LLM verification on each finding in parallel.
 *  Returns findings with CONFIRMED boosted, PLAUSIBLE kept, REFUTED dropped. */
async function verifyFindingsLLM(
  client: LLMClient,
  diffText: string,
  findings: Finding[],
  notify: (event: any) => void
): Promise<Finding[]> {
  notify({
    phase: "aggregate",
    message: `Verifying ${findings.length} finding(s) independently...`,
    percent: 82,
  });

  const systemPrompt = buildVerifySystemPrompt();

  const results = await Promise.allSettled(
    findings.map(async (f) => {
      const info = buildVerifyFindingInfo(f);
      const verdict = await client.verify(systemPrompt, info, diffText);
      return { finding: f, verdict };
    })
  );

  let confirmed = 0;
  let plausible = 0;
  let refuted = 0;

  const kept: Finding[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status !== "fulfilled") {
      // Verify call failed — keep as PLAUSIBLE so user knows to check manually
      plausible++;
      kept.push({ ...findings[i]!, verdict: "PLAUSIBLE" });
      continue;
    }

    const { finding, verdict } = result.value;
    const upper = verdict.toUpperCase();

    if (upper.startsWith("CONFIRMED")) {
      confirmed++;
      kept.push({
        ...finding,
        confidence: Math.min(1.0, Math.round((finding.confidence + 0.10) * 100) / 100),
        verdict: "CONFIRMED",
      });
    } else if (upper.startsWith("REFUTED")) {
      refuted++;
      // Keep rather than drop — verifier can be wrong. Downgrade to LOW and reduce confidence.
      kept.push({
        ...finding,
        severity: "LOW",
        confidence: Math.max(0.1, Math.round((finding.confidence - 0.20) * 100) / 100),
        issue: `${finding.issue}`,
        verdict: "REFUTED",
      });
    } else {
      plausible++;
      kept.push({ ...finding, verdict: "PLAUSIBLE" });
    }
  }

  notify({
    phase: "aggregate",
    message: `Verification: ${confirmed} confirmed, ${plausible} plausible, ${refuted} refuted`,
    percent: 84,
  });

  return kept;
}

/** Serialize findings into compact text for the Chinese summary LLM call */
function buildFindingsSummary(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";

  const lines: string[] = [];
  const severities = [...SEVERITY_ORDER];
  for (const sev of severities) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${sev} (${group.length})`);
    for (const f of group) {
      lines.push(`- [${f.dimension}] ${f.file}:${f.line ?? "-"} — ${f.issue}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function ciSummary(checks: Array<{ conclusion: string | null }>): string {
  if (checks.length === 0) return "no checks";
  const failed = checks.filter((c) => c.conclusion === "failure").length;
  if (failed > 0) return `${failed} FAILED`;
  return "all pass";
}
