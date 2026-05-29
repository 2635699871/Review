import { describe, it, expect } from "vitest";
import { filterFiles, isHighRisk, categorizeFile } from "../../src/utils/file-filter.js";
import { aggregate, determineVerdict } from "../../src/pipeline/aggregator.js";
import { gateFindings } from "../../src/core/confidence-gate.js";
import { buildDiffText, buildMetadataText } from "../../src/pipeline/context-builder.js";
import type { Finding, PRFile } from "../../src/types.js";
import samplePR from "../fixtures/sample-pr.json" assert { type: "json" };

/**
 * End-to-end pipeline test using a sample PR fixture.
 * Validates the full flow: filter → diff building → (mock) review → aggregate → verdict.
 */
describe("full pipeline with sample PR", () => {
  const files = samplePR.files as unknown as PRFile[];

  it("filters out lockfiles and keeps source files", () => {
    const result = filterFiles(files);

    // package-lock.json should be excluded
    expect(result.excluded.some((f) => f.filename === "package-lock.json")).toBe(true);
    // Source files should be included
    expect(result.filtered.some((f) => f.filename === "src/auth/jwt-middleware.ts")).toBe(true);
    expect(result.filtered.some((f) => f.filename === "src/auth/login.ts")).toBe(true);
    expect(result.filtered.some((f) => f.filename === "src/utils/format.ts")).toBe(true);
  });

  it("identifies high-risk auth files", () => {
    expect(isHighRisk("src/auth/jwt-middleware.ts")).toBe(true);
    expect(isHighRisk("src/auth/login.ts")).toBe(true);
    expect(isHighRisk("src/utils/format.ts")).toBe(false);
  });

  it("categorizes files correctly", () => {
    expect(categorizeFile({ filename: "src/auth/jwt-middleware.ts" } as PRFile)).toBe("source");
    expect(categorizeFile({ filename: "README.md" } as PRFile)).toBe("doc");
    expect(categorizeFile({ filename: "tests/app.test.ts" } as PRFile)).toBe("test");
  });

  it("builds diff text from filtered files", () => {
    const result = filterFiles(files);
    const diffText = buildDiffText(result.filtered);

    expect(diffText).toContain("jwt-middleware.ts");
    expect(diffText).toContain("DEFAULT_SECRET");
    expect(diffText).toContain("login.ts");
    expect(diffText).toContain("format.ts");
  });

  it("builds metadata from PR data", () => {
    const text = buildMetadataText({
      title: samplePR.title,
      author: samplePR.author,
      body: samplePR.body,
      baseBranch: samplePR.baseBranch,
      headBranch: samplePR.headBranch,
      fileCount: samplePR.changedFiles,
      additions: samplePR.additions,
      deletions: samplePR.deletions,
      commits: samplePR.commits.map((c) => c.message),
    });

    expect(text).toContain("Add user authentication middleware");
    expect(text).toContain("jane-dev");
    expect(text).toContain("feature/auth");
  });

  it("produces a BLOCK verdict for CRITICAL findings", () => {
    const findings: Finding[] = [
      {
        severity: "CRITICAL",
        dimension: "security",
        file: "src/auth/jwt-middleware.ts",
        line: 5,
        category: "hardcoded-secret",
        issue: "JWT secret defaults to hardcoded value — exploitable in production",
        fix: "Remove the default value. Throw an error if JWT_SECRET env var is not set.",
        confidence: 0.95,
      },
      {
        severity: "MEDIUM",
        dimension: "correctness",
        file: "src/utils/format.ts",
        line: 12,
        category: "null-safety",
        issue: "Missing null check on formatDate input",
        fix: "Add guard clause: if (!date) return '';",
        confidence: 0.85,
      },
    ];

    const { findings: ranked, actionableRate } = aggregate(findings);
    const verdict = determineVerdict(ranked);

    expect(verdict).toBe("BLOCK");
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.severity).toBe("CRITICAL");
    expect(actionableRate).toBeGreaterThan(0.5);
  });

  it("produces a COMMENT verdict for MEDIUM/LOW findings only", () => {
    const findings: Finding[] = [
      {
        severity: "MEDIUM",
        dimension: "maintainability",
        file: "src/utils/format.ts",
        line: 12,
        category: "magic-number",
        issue: "Magic string used for date format",
        fix: "Extract to a named constant: const DATE_FORMAT = 'yyyy-MM-dd'",
        confidence: 0.75,
      },
    ];

    const { findings: ranked } = aggregate(findings);
    const verdict = determineVerdict(ranked);

    expect(verdict).toBe("COMMENT");
  });

  it("gates out vague findings in the pipeline", () => {
    const findings: Finding[] = [
      {
        severity: "MEDIUM",
        dimension: "maintainability",
        file: "src/auth/login.ts",
        line: 10,
        category: "naming",
        issue: "Consider improving the variable naming",
        fix: "Consider using more descriptive names",
        confidence: 0.7,
      },
      {
        severity: "HIGH",
        dimension: "correctness",
        file: "src/auth/jwt-middleware.ts",
        line: 8,
        category: "null-safety",
        issue: "token may be undefined when Authorization header is missing Bearer prefix",
        fix: "Add explicit check: if (!token || token.length === 0) return res.status(401);",
        confidence: 0.88,
      },
    ];

    const { kept, dropped } = gateFindings(findings);

    // The vague finding should be dropped
    expect(dropped).toBeGreaterThanOrEqual(1);
    // The concrete finding should be kept
    expect(kept.some((f) => f.category === "null-safety")).toBe(true);
  });
});
