import type { Finding, Severity } from "../types.js";
import { isKnownFalsePositive } from "../storage/history.js";

/**
 * Confidence Gate — the 4-question pre-report filter plus feedback learning.
 *
 * Based on ECC code-reviewer patterns. Each finding must pass all 4 questions.
 * If any question fails, the finding is dropped or downgraded.
 * Also suppresses findings that match known false-positive patterns from past feedback.
 */

interface GateResult {
  passed: boolean;
  downgraded: boolean;
  reason?: string;
}

/**
 * Apply the 4-question confidence gate to a single finding.
 */
export function gateFinding(finding: Finding): GateResult {
  const checks = [
    canCiteExactLine(finding),
    canDescribeFailure(finding),
    hasSurroundingContext(finding),
    isSeverityDefensible(finding),
  ];

  // Separate hard failures (drop) from soft failures (downgrade only)
  const hardFailures = checks.filter((c) => !c.passed);
  const downgradeFlags = checks.filter((c) => c.downgrade === true);

  // Real problems → drop
  if (hardFailures.length > 0) {
    return {
      passed: false,
      downgraded: false,
      reason: hardFailures.map((f) => f.reason!).join("; "),
    };
  }

  // Severity/vagueness concerns → downgrade instead of drop
  if (downgradeFlags.length > 0) {
    return {
      passed: true,
      downgraded: true,
      reason: downgradeFlags.map((f) => f.reason!).filter(Boolean).join("; ") || "Severity flagged as overinflated",
    };
  }

  return { passed: true, downgraded: false };
}

/** Gate 1: Can we cite the exact line? */
function canCiteExactLine(finding: Finding): { passed: boolean; downgrade?: boolean; reason?: string } {
  if (!finding.file) {
    return { passed: false, reason: "File path is missing" };
  }
  return { passed: true };
}

/** Gate 2: Can we describe a concrete failure mode? */
function canDescribeFailure(finding: Finding): { passed: boolean; downgrade?: boolean; reason?: string } {
  // Check for vague descriptions — downgrade rather than drop
  const vaguePatterns = [
    /^consider/i,
    /^maybe/i,
    /might be/i,
    /could be improved/i,
    /is not ideal/i,
    /best practice/i,
    /recommend reviewing/i,
    /possibly/i,
    /potentially/i,
  ];

  for (const pattern of vaguePatterns) {
    if (pattern.test(finding.issue) && !finding.fix) {
      return {
        passed: true,
        downgrade: true,
        reason: `Vague issue description: "${finding.issue.slice(0, 60)}"`,
      };
    }
  }

  // The fix should be concrete — downgrade rather than drop
  const vagueFixes = [/^refactor/i, /^improve/i, /^fix it/i, /^consider/i, /^review/i];
  for (const pattern of vagueFixes) {
    if (pattern.test(finding.fix)) {
      return {
        passed: true,
        downgrade: true,
        reason: `Vague fix suggestion: "${finding.fix.slice(0, 60)}"`,
      };
    }
  }

  return { passed: true };
}

/** Gate 3: Does the context suggest we understand the code? */
function hasSurroundingContext(finding: Finding): { passed: boolean; downgrade?: boolean; reason?: string } {
  // Findings that mention "caller" or "import" without evidence
  if (
    /\bcaller\b/.test(finding.issue) &&
    !/\bcalls?\b/.test(finding.issue) &&
    finding.confidence < 0.8
  ) {
    return {
      passed: false,
      reason: "References callers without specific evidence",
    };
  }

  return { passed: true };
}

/** Gate 4: Is the severity defensible? If not, downgrade instead of drop. */
function isSeverityDefensible(finding: Finding): { passed: boolean; downgrade?: boolean; reason?: string } {
  // CRITICAL must involve security vulnerability or data loss risk
  const criticalTerms = [
    /security/i,
    /vulnerability/i,
    /exploit/i,
    /injection/i,
    /data loss/i,
    /data leak/i,
    /credentials/i,
    /secret/i,
    /token/i,
    /password/i,
    /crash/i,
    /denial of service/i,
    /race condition/i,
    /corruption/i,
    /bypass/i,
  ];

  if (finding.severity === "CRITICAL") {
    const hasEvidence = criticalTerms.some(
      (p) => p.test(finding.issue) || p.test(finding.fix)
    );
    if (!hasEvidence) {
      return {
        passed: true,
        downgrade: true,
        reason: "severity",
      };
    }
  }

  // HIGH must involve a likely bug, not just a code smell
  if (finding.severity === "HIGH") {
    const smellPatterns = [
      /could be/i,
      /might be/i,
      /sometimes/i,
      /occasionally/i,
      /it is possible/i,
    ];
    const isSmell = smellPatterns.some((p) => p.test(finding.issue));
    if (isSmell && finding.confidence <= 0.85) {
      return { passed: true, downgrade: true, reason: "severity" };
    }
  }

  return { passed: true };
}

/**
 * Apply the confidence gate to all findings.
 * Returns filtered and severity-adjusted findings.
 */
export function gateFindings(findings: Finding[]): {
  kept: Finding[];
  dropped: number;
  downgraded: number;
} {
  let dropped = 0;
  let downgraded = 0;

  const kept: Finding[] = [];

  for (const finding of findings) {
    // Suppress known false-positive patterns from historical feedback
    if (isKnownFalsePositive(finding.file, finding.category)) {
      dropped++;
      continue;
    }

    const result = gateFinding(finding);

    if (!result.passed) {
      dropped++;
      continue;
    }

    if (result.downgraded) {
      downgraded++;
      kept.push({ ...finding, severity: downgrade(finding.severity) });
    } else {
      kept.push(finding);
    }
  }

  return { kept, dropped, downgraded };
}

function downgrade(severity: Severity): Severity {
  if (severity === "CRITICAL") return "HIGH";
  if (severity === "HIGH") return "MEDIUM";
  if (severity === "MEDIUM") return "LOW";
  return "LOW";
}
