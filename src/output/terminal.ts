import type { Finding, ReviewResult, Severity } from "../types.js";
import { countBySeverity } from "../pipeline/aggregator.js";
import chalk from "chalk";

const SEVERITY_COLORS: Record<Severity, (s: string) => string> = {
  CRITICAL: chalk.red.bold,
  HIGH: chalk.yellow.bold,
  MEDIUM: chalk.cyan,
  LOW: chalk.gray,
};

const SEVERITY_ICONS: Record<Severity, string> = {
  CRITICAL: "!!",
  HIGH: "!",
  MEDIUM: "~",
  LOW: "·",
};

const VERDICT_LABELS: Record<string, string> = {
  BLOCK: "BLOCK",
  REQUEST_CHANGES: "REQUEST CHANGES",
  COMMENT: "COMMENT",
};

const DIMENSION_LABELS: Record<string, string> = {
  correctness: "Correctness",
  security: "Security",
  performance: "Performance",
  maintainability: "Maintainability",
};

/** Render the full terminal review output */
export function renderTerminal(result: ReviewResult): string {
  const lines: string[] = [];

  // Header
  lines.push(divider());
  lines.push(
    center(
      `PR Review: #${result.pr.number} — ${result.pr.title}`
    )
  );
  lines.push(divider());

  // Metadata
  const counts = countBySeverity(result.findings);
  lines.push(
    ` Repo:  ${result.pr.owner}/${result.pr.repo}`
  );
  lines.push(` Author: ${result.pr.author}`);
  lines.push(
    ` Branch: ${result.pr.headBranch} → ${result.pr.baseBranch}`
  );
  lines.push(
    ` State:  ${result.pr.draft ? "DRAFT" : result.pr.state.toUpperCase()} | CI: ${ciLine(result)}`
  );
  lines.push(
    ` Files: ${result.pr.changedFiles} changed (+${result.pr.additions} -${result.pr.deletions}) | ${result.findings.length} finding(s)`
  );
  lines.push(divider());

  // Summary
  if (result.summary) {
    lines.push("");
    lines.push(chalk.bold("  Changes Summary"));
    lines.push("  " + "-".repeat(48));
    for (const line of wrapText(result.summary, 60)) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  // Findings by severity
  const severities: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  for (const severity of severities) {
    const group = result.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;

    const color = SEVERITY_COLORS[severity];
    const icon = SEVERITY_ICONS[severity];
    const count = counts[severity];

    lines.push("");
    lines.push(
      color(
        `  ${icon} ${severity} (${count})`
      ) +
        severityDetail(severity)
    );
    lines.push("  " + "-".repeat(48));

    for (const finding of group) {
      lines.push("");
      lines.push(
        color(`  [${finding.severity}]`) +
          " " +
          chalk.white(finding.issue)
      );
      lines.push(
        chalk.gray(`  Dimension: ${DIMENSION_LABELS[finding.dimension] ?? finding.dimension}`)
      );
      lines.push(
        chalk.gray(
          `  File: ${finding.file}${finding.line ? ":" + finding.line : ""}`
        )
      );
      if (finding.fix && finding.fix !== "See issue description") {
        lines.push(chalk.green(`  Fix:     ${finding.fix}`));
      }
      if (finding.zhBrief) {
        lines.push(chalk.gray(`  简评:    ${finding.zhBrief}`));
      }
    }
  }

  // Empty state
  if (result.findings.length === 0) {
    lines.push("");
    lines.push(chalk.green("  No issues found. Clean PR!"));
  }

  // Verdict
  lines.push("");
  lines.push(divider());
  lines.push(chalk.bold("  Verdict"));
  lines.push("  " + "-".repeat(48));
  const verdictColor =
    result.verdict === "BLOCK"
      ? chalk.red.bold
      : result.verdict === "REQUEST_CHANGES"
        ? chalk.yellow.bold
        : chalk.green;
  lines.push(
    `  ${verdictColor(VERDICT_LABELS[result.verdict] ?? result.verdict)} — ${verdictExplanation(result)}`
  );
  lines.push("");
  lines.push(
    chalk.gray(
      `  Confidence: ${Math.round(result.actionableRate * 100)}% actionable`
    )
  );
  lines.push(
    chalk.gray(`  Full report: .pr-review/pr-${result.pr.number}-review.md`)
  );
  lines.push(divider());
  lines.push("");

  return lines.join("\n");
}

function divider(): string {
  return "=".repeat(58);
}

function center(text: string): string {
  const width = 58;
  const pad = Math.max(0, Math.floor((width - stripAnsi(text).length) / 2));
  return " ".repeat(pad) + text;
}

function ciLine(result: ReviewResult): string {
  const checks = result.pr.ciStatus;
  if (checks.length === 0) return "no checks";
  const failed = checks.filter((c) => c.conclusion === "failure").length;
  if (failed > 0) return chalk.red(`${failed} FAILED`);
  const pending = checks.filter(
    (c) => !c.conclusion || c.conclusion === "pending"
  ).length;
  if (pending > 0) return chalk.yellow(`${pending} pending`);
  return chalk.green("all pass");
}

function severityDetail(severity: Severity): string {
  switch (severity) {
    case "CRITICAL":
      return " — must fix before merge";
    case "HIGH":
      return " — should fix before merge";
    case "MEDIUM":
      return " — consider fixing";
    case "LOW":
      return " — optional";
  }
}

function verdictExplanation(result: ReviewResult): string {
  const counts = countBySeverity(result.findings);
  if (counts.CRITICAL > 0) {
    return `${counts.CRITICAL} CRITICAL issue(s) must be resolved before merge.`;
  }
  if (counts.HIGH > 0) {
    return `${counts.HIGH} HIGH issue(s) should be addressed.`;
  }
  return "No blocking issues found.";
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth) {
      lines.push(current.trim());
      current = word;
    } else {
      current += " " + word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
