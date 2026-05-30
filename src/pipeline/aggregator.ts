import type { Finding, ReviewResult, Severity } from "../types.js";
import { gateFindings } from "../core/confidence-gate.js";

/**
 * Aggregator — deduplicate, rank, and filter findings from multiple dimensions.
 */

interface AggregateResult {
  findings: Finding[];
  dropped: number;
  downgraded: number;
  actionableRate: number;
}

/**
 * Aggregate findings from all dimensions:
 * 1. Deduplicate near-identical findings
 * 2. Apply confidence gate
 * 3. Rank by severity
 * 4. Calculate actionable rate
 * 5. Trim low-signal findings if rate is below threshold
 */
export function aggregate(
  allFindings: Finding[],
  options?: { targetActionableRate?: number }
): AggregateResult {
  const target = options?.targetActionableRate ?? 0.6;

  // Step 1: Deduplicate
  const deduped = deduplicate(allFindings);

  // Step 2: Confidence gate
  const { kept, dropped, downgraded } = gateFindings(deduped);

  // Step 3: Rank by severity
  const ranked = rankBySeverity(kept);

  // Step 4: Calculate actionable rate
  const actionableRate = calculateActionableRate(ranked);

  // Step 5: Trim low-signal findings if below threshold
  let findings = ranked;
  if (actionableRate < target) {
    findings = trimLowSignal(findings, target);
  }

  return {
    findings,
    dropped,
    downgraded,
    actionableRate: calculateActionableRate(findings),
  };
}

/** Determine verdict based on findings */
export function determineVerdict(findings: Finding[]): "BLOCK" | "REQUEST_CHANGES" | "COMMENT" {
  const hasCritical = findings.some((f) => f.severity === "CRITICAL");
  const hasHigh = findings.some((f) => f.severity === "HIGH");

  if (hasCritical) return "BLOCK";
  if (hasHigh) return "REQUEST_CHANGES";
  return "COMMENT";
}

/** Count findings by severity */
export function countBySeverity(
  findings: Finding[]
): Record<Severity, number> {
  return {
    CRITICAL: findings.filter((f) => f.severity === "CRITICAL").length,
    HIGH: findings.filter((f) => f.severity === "HIGH").length,
    MEDIUM: findings.filter((f) => f.severity === "MEDIUM").length,
    LOW: findings.filter((f) => f.severity === "LOW").length,
  };
}

// ─── Private Helpers ────────────────────────────────────────

function deduplicate(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];

  for (const f of findings) {
    // Hash: file + line + category
    const key = `${f.file ?? "?"}:${f.line ?? "N"}:${f.category ?? "?"}`;
    if (seen.has(key)) continue;

    // Check near-duplicates with same file+dimension
    const nearDup = result.find(
      (r) =>
        r.file === f.file &&
        r.dimension === f.dimension &&
        r.line === f.line &&
        levenshteinDistance(r.issue ?? "", f.issue ?? "") < 0.3 * Math.max((r.issue ?? "").length, (f.issue ?? "").length)
    );

    if (nearDup) {
      // Keep the higher-severity finding
      const sevRank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
      if ((sevRank[f.severity] ?? 0) > (sevRank[nearDup.severity] ?? 0)) {
        result[result.indexOf(nearDup)] = f;
      }
      continue;
    }

    seen.add(key);
    result.push(f);
  }

  return result;
}

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function rankBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity);
    const sb = SEVERITY_ORDER.indexOf(b.severity);
    if (sa !== sb) return sa - sb;
    // Within same severity, sort by file path
    return a.file.localeCompare(b.file);
  });
}

function calculateActionableRate(findings: Finding[]): number {
  if (findings.length === 0) return 1.0;
  const actionable = findings.filter((f) => f.fix && f.fix !== "See issue description");
  return actionable.length / findings.length;
}

function trimLowSignal(findings: Finding[], target: number): Finding[] {
  // Remove LOW findings until target is met
  const lows = findings.filter((f) => f.severity === "LOW");
  if (lows.length === 0) return findings;

  let result = [...findings];
  while (calculateActionableRate(result) < target && result.some((f) => f.severity === "LOW")) {
    // Remove the last LOW finding
    const lastLowIdx = result.map((f) => f.severity).lastIndexOf("LOW");
    if (lastLowIdx === -1) break;
    result.splice(lastLowIdx, 1);
  }

  return result;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
      }
    }
  }

  return dp[m]![n]!;
}
